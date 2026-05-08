//! tmux control mode (-C) protocol handling.
//!
//! Provides encoding/decoding for the tmux control mode protocol,
//! plus `CcReader` (protocol parser) and `CcWriter` (command encoder).

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use tokio::sync::Notify;

// -- Window-close notification registry --
//
// In production tmux routes `%unlinked-window-close @X` events to the
// grouped clients that are NOT the one whose window was destroyed.  So
// the pane that actually died never sees its own close — we have to
// route the event cross-reader.  Each WS handler registers its window_id
// here and waits on the returned Notify; whichever other reader observes
// the close event calls `notify_window_closed(id)`.

fn registry() -> &'static Mutex<HashMap<String, Arc<Notify>>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, Arc<Notify>>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Register a window_id to listen for cross-reader close events.
/// Returns a `Notify` whose `notified()` future resolves when any reader
/// observes `%unlinked-window-close` for this window.
pub fn register_window_close(window_id: String) -> Arc<Notify> {
    let notify = Arc::new(Notify::new());
    registry().lock().unwrap().insert(window_id, notify.clone());
    notify
}

/// Remove a previously registered window_id.  Idempotent.
pub fn unregister_window_close(window_id: &str) {
    registry().lock().unwrap().remove(window_id);
}

/// Signal that `window_id` was observed being closed.  No-op if the
/// window is not currently registered.  Uses `notify_one` so the signal
/// is stored as a permit even if no waiter is currently polling —
/// the first future to await `notified()` will immediately resolve.
pub fn notify_window_closed(window_id: &str) {
    let notify = registry().lock().unwrap().get(window_id).cloned();
    if let Some(n) = notify {
        n.notify_one();
    }
}

// -- Protocol encode/decode --

/// Decode a tmux control mode %output value.
/// tmux escapes non-printable characters and backslash as octal \NNN.
pub fn decode_output(value: &[u8]) -> Vec<u8> {
    let mut result = Vec::with_capacity(value.len());
    let mut i = 0;
    while i < value.len() {
        if value[i] == b'\\' && i + 3 < value.len() {
            if let Some(byte) = parse_octal(&value[i + 1..i + 4]) {
                result.push(byte);
                i += 4;
                continue;
            }
            if value[i + 1] == b'\\' {
                result.push(b'\\');
                i += 2;
                continue;
            }
        } else if value[i] == b'\\' && i + 1 < value.len() && value[i + 1] == b'\\' {
            result.push(b'\\');
            i += 2;
            continue;
        }
        result.push(value[i]);
        i += 1;
    }
    result
}

fn parse_octal(digits: &[u8]) -> Option<u8> {
    if digits.len() < 3 { return None; }
    let d0 = (digits[0] as char).to_digit(8)?;
    let d1 = (digits[1] as char).to_digit(8)?;
    let d2 = (digits[2] as char).to_digit(8)?;
    let val = d0 * 64 + d1 * 8 + d2;
    if val <= 255 { Some(val as u8) } else { None }
}

/// Encode user input as a tmux `send-keys -H` command.
/// Encode user input as one or more tmux `send-keys -H` commands.
/// Large inputs are chunked to avoid overwhelming tmux with a single
/// massive command line (e.g. a 12KB paste would be a 36KB command).
pub fn encode_input(pane_id: &str, data: &[u8]) -> Vec<u8> {
    const CHUNK_SIZE: usize = 512;
    if data.is_empty() {
        return format!("send-keys -H -t {pane_id}\n").into_bytes();
    }
    let mut result = Vec::with_capacity(data.len() * 4);
    for chunk in data.chunks(CHUNK_SIZE) {
        let mut cmd = format!("send-keys -H -t {pane_id}");
        for byte in chunk {
            cmd.push_str(&format!(" {:02x}", byte));
        }
        cmd.push('\n');
        result.extend_from_slice(cmd.as_bytes());
    }
    result
}

/// Encode a resize command for tmux control mode.
pub fn encode_resize(cols: u16, rows: u16) -> Vec<u8> {
    format!("refresh-client -C {cols},{rows}\n").into_bytes()
}

// -- Line parsing helpers --

/// Find position of first \r\n in buffer.
fn find_crlf(buf: &[u8]) -> Option<usize> {
    buf.windows(2).position(|w| w == b"\r\n")
}

/// Parse a %output line, returning (pane-id, value).
fn parse_output_line(line: &[u8]) -> Option<(&[u8], &[u8])> {
    let rest = line.strip_prefix(b"%output ")?;
    let space_pos = rest.iter().position(|&b| b == b' ')?;
    Some((&rest[..space_pos], &rest[space_pos + 1..]))
}


/// Filter escape sequences from terminal output.
///
/// Stripped:
/// - \e[?1000h/l, \e[?1002h/l, \e[?1003h/l, \e[?1006h/l — mouse tracking
/// - \e[3J — clear scrollback buffer (protects user's scroll history)
///
fn filter_escapes(data: &[u8], pass_mouse: bool) -> Vec<u8> {
    let mut result = Vec::with_capacity(data.len());
    let mut i = 0;
    let mut saw_erase_display = false;
    while i < data.len() {
        if data[i] == 0x1b && i + 1 < data.len() && data[i + 1] == b'[' {
            // \e[2J — erase display: pass through and flag it so the
            // immediately following \e[3J is also let through.
            if i + 3 < data.len() && data[i + 2] == b'2' && data[i + 3] == b'J' {
                saw_erase_display = true;
                result.extend_from_slice(&data[i..i + 4]);
                i += 4;
                continue;
            }
            // \e[3J — clear scrollback buffer: strip UNLESS it immediately
            // follows \e[2J. Claude writes 100+ lines per full redraw,
            // overflowing the viewport into scrollback. The paired \e[3J
            // cleans up this overflow; without it, duplicate frames accumulate.
            if i + 3 < data.len() && data[i + 2] == b'3' && data[i + 3] == b'J' {
                if saw_erase_display {
                    saw_erase_display = false;
                    result.extend_from_slice(&data[i..i + 4]);
                    i += 4;
                    continue;
                }
                i += 4;
                continue;
            }
            // Any other ESC[ sequence clears the \e[2J flag
            saw_erase_display = false;
            if !pass_mouse && i + 4 < data.len() && data[i + 2] == b'?' {
                let rest = &data[i + 3..];
                if rest.starts_with(b"1000h") || rest.starts_with(b"1000l")
                    || rest.starts_with(b"1002h") || rest.starts_with(b"1002l")
                    || rest.starts_with(b"1003h") || rest.starts_with(b"1003l")
                    || rest.starts_with(b"1006h") || rest.starts_with(b"1006l")
                {
                    i += 8;
                    continue;
                }
            }
        } else {
            saw_erase_display = false;
        }
        result.push(data[i]);
        i += 1;
    }
    result
}

// -- CcReader: protocol parser --

/// Events produced by `CcReader` when parsing tmux control mode output.
pub enum CcEvent {
    /// Decoded terminal output bytes for the target pane.
    /// `alternate_screen` is true when the app inside the pane has switched
    /// to the alternate screen buffer (emacs, vim, less — but NOT Claude).
    Output { data: Vec<u8>, alternate_screen: bool },
    /// The tmux control client is exiting (generic %exit).
    /// This fires when the linked session is killed (e.g. reconnection cleanup)
    /// as well as when the session has no more windows.
    Exit,
    /// Our own window was destroyed.  In production tmux does not deliver
    /// this to the pane that actually died — it only arrives in other
    /// grouped clients and gets routed here via the window-close registry.
    WindowClosed,
    /// Observed `%unlinked-window-close` for a window other than ours.
    /// The caller should route this to whichever reader owns `window_id`.
    OtherWindowClosed { window_id: String },
    /// The pane's title changed (tmux %pane-title-changed notification).
    PaneTitleChanged { title: String },
}

/// Parses tmux control mode output from raw PTY bytes.
///
/// Feed raw bytes with `feed()`, then drain events with `next_event()`.
/// Only `%output` for the specified pane ID is returned; all other
/// control mode messages are silently consumed.
pub struct CcReader {
    line_buf: Vec<u8>,
    dcs_stripped: bool,
    pane_id: String,
    window_id: Option<String>,
    saw_exit: bool,
    alternate_screen: bool,
    pass_mouse: bool,
}

impl CcReader {
    pub fn new(pane_id: String) -> Self {
        Self {
            line_buf: Vec::with_capacity(8192),
            dcs_stripped: false,
            pane_id,
            window_id: None,
            saw_exit: false,
            alternate_screen: false,
            pass_mouse: false,
        }
    }

    pub fn set_pass_mouse(&mut self, pass: bool) {
        self.pass_mouse = pass;
    }

    /// Set the window ID to monitor for `%window-close` notifications.
    /// When the window containing our pane closes (e.g. shell exits),
    /// the reader will emit `CcEvent::Exit`.
    pub fn set_window_id(&mut self, id: String) {
        self.window_id = Some(id);
    }

    /// Set the initial alternate screen state (e.g. from a tmux query).
    pub fn set_alternate_screen(&mut self, alt: bool) {
        self.alternate_screen = alt;
    }

    /// Whether the app in the pane is currently using the alternate screen buffer.
    #[allow(dead_code)]
    pub fn alternate_screen(&self) -> bool {
        self.alternate_screen
    }

    /// Scan decoded output for alternate screen enable/disable sequences.
    /// Processes left-to-right so the last occurrence in the data wins.
    fn scan_alternate_screen(&mut self, data: &[u8]) {
        let mut i = 0;
        while i < data.len() {
            if data[i] == 0x1b && i + 4 < data.len() && data[i + 1] == b'[' && data[i + 2] == b'?' {
                // Check for \e[?1049h/l, \e[?1047h/l, \e[?47h/l
                if data[i + 3..].starts_with(b"1049h") { self.alternate_screen = true; i += 8; continue; }
                if data[i + 3..].starts_with(b"1049l") { self.alternate_screen = false; i += 8; continue; }
                if data[i + 3..].starts_with(b"1047h") { self.alternate_screen = true; i += 8; continue; }
                if data[i + 3..].starts_with(b"1047l") { self.alternate_screen = false; i += 8; continue; }
                if data[i + 3..].starts_with(b"47h") { self.alternate_screen = true; i += 6; continue; }
                if data[i + 3..].starts_with(b"47l") { self.alternate_screen = false; i += 6; continue; }
            }
            i += 1;
        }
    }

    /// Append raw bytes from the PTY to the internal buffer.
    pub fn feed(&mut self, data: &[u8]) {
        self.line_buf.extend_from_slice(data);

        // tmux -CC prepends a DCS sequence \x1bP1000p once at the start.
        if !self.dcs_stripped {
            if let Some(pos) = self.line_buf.windows(8).position(|w| w == b"\x1bP1000p") {
                self.line_buf.drain(pos..pos + 8);
            }
            if self.line_buf.windows(6).any(|w| w == b"%begin") {
                self.dcs_stripped = true;
            }
        }
    }

    /// Parse and return the next event, or `None` if no complete line is available.
    pub fn next_event(&mut self) -> Option<CcEvent> {
        if self.saw_exit {
            return None;
        }

        loop {
            let pos = find_crlf(&self.line_buf)?;
            let line = self.line_buf[..pos].to_vec();
            self.line_buf.drain(..pos + 2);

            if line.starts_with(b"%output ") {
                if let Some((pid, value)) = parse_output_line(&line) {
                    if pid == self.pane_id.as_bytes() {
                        let decoded = decode_output(value);
                        if !decoded.is_empty() {
                            // Track alternate screen switches
                            self.scan_alternate_screen(&decoded);
                            let cleaned = filter_escapes(&decoded, self.pass_mouse);
                            if !cleaned.is_empty() {
                                return Some(CcEvent::Output {
                                    data: cleaned,
                                    alternate_screen: self.alternate_screen,
                                });
                            }
                        }
                    }
                }
                // Output for another pane or empty — skip and try next line
                continue;
            }

            if line.starts_with(b"%exit") {
                self.saw_exit = true;
                return Some(CcEvent::Exit);
            }

            // %pane-title-changed %<pane_id> <title>
            if line.starts_with(b"%pane-title-changed ") {
                if let Ok(s) = std::str::from_utf8(&line[20..]) {
                    if let Some(space) = s.find(' ') {
                        let pane = &s[..space];
                        if pane.as_bytes() == self.pane_id.as_bytes() {
                            let title = s[space + 1..].to_string();
                            return Some(CcEvent::PaneTitleChanged { title });
                        }
                    }
                }
                continue;
            }

            // Detect window close — when the pane's window is destroyed
            // (e.g. shell exits), the linked session still has other windows
            // so %exit won't fire. Detect it via %unlinked-window-close
            // (grouped sessions) or %window-close (standalone sessions).
            // Only %unlinked-window-close means the window was truly destroyed
            // from the session group (pane exited).  %window-close also fires
            // when a linked session is torn down during reconnection cleanup,
            // which is NOT a real pane death.
            let wclose_prefix = if line.starts_with(b"%unlinked-window-close ") {
                Some(b"%unlinked-window-close ".len())
            } else {
                None
            };
            if let Some(prefix_len) = wclose_prefix {
                let rest = std::str::from_utf8(&line[prefix_len..]).unwrap_or("?");
                let line_str = std::str::from_utf8(&line).unwrap_or("?");
                if let Some(ref wid) = self.window_id {
                    if rest.as_bytes() == wid.as_bytes() {
                        tlog!("[cc] pane={}: {line_str} — matches our window {wid}, emitting WindowClosed", self.pane_id);
                        self.saw_exit = true;
                        return Some(CcEvent::WindowClosed);
                    }
                }
                tlog!("[cc] pane={}: {line_str} — emitting OtherWindowClosed", self.pane_id);
                return Some(CcEvent::OtherWindowClosed { window_id: rest.to_string() });
            }

            // All other % lines (notifications, %begin/%end, etc.) — skip
            continue;
        }
    }
}

// -- CcWriter: command encoder --

/// Encodes commands for sending to a tmux control mode client.
pub struct CcWriter {
    pane_id: String,
}

impl CcWriter {
    pub fn new(pane_id: String) -> Self {
        Self { pane_id }
    }

    /// Encode user input as `send-keys -H` command bytes.
    pub fn input(&self, data: &[u8]) -> Vec<u8> {
        encode_input(&self.pane_id, data)
    }

    /// Encode a resize as `refresh-client -C` command bytes.
    pub fn resize(&self, cols: u16, rows: u16) -> Vec<u8> {
        encode_resize(cols, rows)
    }
}

// -- Tests --

#[cfg(test)]
mod tests {
    use super::*;

    // -- decode_output --

    #[test]
    fn test_decode_plain_text() {
        assert_eq!(decode_output(b"hello"), b"hello");
    }

    #[test]
    fn test_decode_octal_escape() {
        assert_eq!(decode_output(b"\\033[31m"), b"\x1b[31m");
    }

    #[test]
    fn test_decode_cr_lf() {
        assert_eq!(decode_output(b"hello\\015\\012"), b"hello\r\n");
    }

    #[test]
    fn test_decode_backslash() {
        assert_eq!(decode_output(b"a\\\\b"), b"a\\b");
    }

    #[test]
    fn test_decode_null_byte() {
        assert_eq!(decode_output(b"\\000"), b"\x00");
    }

    #[test]
    fn test_decode_high_byte() {
        assert_eq!(decode_output(b"\\377"), b"\xff");
    }

    #[test]
    fn test_decode_mixed() {
        let input = b"\\033[?2004l\\015hello\\015\\012";
        let expected = b"\x1b[?2004l\rhello\r\n";
        assert_eq!(decode_output(input), expected);
    }

    #[test]
    fn test_decode_empty() {
        assert_eq!(decode_output(b""), b"");
    }

    // -- encode_input --

    #[test]
    fn test_encode_ascii() {
        assert_eq!(encode_input("%0", b"A"), b"send-keys -H -t %0 41\n");
    }

    #[test]
    fn test_encode_hello_enter() {
        assert_eq!(encode_input("%0", b"hello\r"), b"send-keys -H -t %0 68 65 6c 6c 6f 0d\n");
    }

    #[test]
    fn test_encode_ctrl_c() {
        assert_eq!(encode_input("%0", b"\x03"), b"send-keys -H -t %0 03\n");
    }

    #[test]
    fn test_encode_empty() {
        assert_eq!(encode_input("%0", b""), b"send-keys -H -t %0\n");
    }

    #[test]
    fn test_encode_large_input_is_chunked() {
        // A 1200-byte paste should be split into multiple send-keys commands
        // so tmux doesn't choke on a single massive command line.
        let data = vec![0x41u8; 1200]; // 1200 bytes of 'A'
        let encoded = encode_input("%0", &data);
        let commands: Vec<&[u8]> = encoded.split(|&b| b == b'\n')
            .filter(|c| !c.is_empty())
            .collect();
        assert!(commands.len() > 1,
            "1200-byte input should produce multiple commands, got {}",
            commands.len());
        // Each command should be a valid send-keys -H
        for cmd in &commands {
            assert!(cmd.starts_with(b"send-keys -H -t %0"),
                "each chunk should be a send-keys command");
        }
        // Total hex bytes across all commands should equal input length
        let total_hex: usize = commands.iter()
            .map(|cmd| {
                let s = std::str::from_utf8(cmd).unwrap();
                s.trim_start_matches("send-keys -H -t %0")
                    .split_whitespace()
                    .count()
            })
            .sum();
        assert_eq!(total_hex, 1200, "all bytes should be accounted for");
    }

    // -- encode_resize --

    #[test]
    fn test_encode_resize() {
        assert_eq!(encode_resize(120, 40), b"refresh-client -C 120,40\n");
    }

    // -- CcReader --

    #[test]
    fn test_reader_output() {
        let mut r = CcReader::new("%0".to_string());
        r.feed(b"%output %0 hello\\015\\012\r\n");
        match r.next_event() {
            Some(CcEvent::Output { data, .. }) => assert_eq!(data, b"hello\r\n"),
            other => panic!("expected Output, got {:?}", other.is_some()),
        }
        assert!(r.next_event().is_none());
    }

    #[test]
    fn test_reader_filters_other_pane() {
        let mut r = CcReader::new("%0".to_string());
        r.feed(b"%output %1 ignored\r\n%output %0 mine\r\n");
        match r.next_event() {
            Some(CcEvent::Output { data, .. }) => assert_eq!(data, b"mine"),
            other => panic!("expected Output for %0, got {:?}", other.is_some()),
        }
        assert!(r.next_event().is_none());
    }

    #[test]
    fn test_reader_exit() {
        let mut r = CcReader::new("%0".to_string());
        r.feed(b"%exit\r\n");
        assert!(matches!(r.next_event(), Some(CcEvent::Exit)));
        assert!(r.next_event().is_none());
    }

    #[test]
    fn test_reader_unlinked_window_close() {
        let mut r = CcReader::new("%0".to_string());
        r.set_window_id("@1".to_string());
        r.feed(b"%unlinked-window-close @1\r\n");
        assert!(matches!(r.next_event(), Some(CcEvent::WindowClosed)));
        assert!(r.next_event().is_none());
    }

    #[test]
    fn test_reader_window_close_ignored() {
        // %window-close fires when a linked session is torn down (reconnection
        // cleanup), not just when a pane exits.  Only %unlinked-window-close
        // is a reliable signal that the window was truly destroyed.
        let mut r = CcReader::new("%0".to_string());
        r.set_window_id("@3".to_string());
        r.feed(b"%window-close @3\r\n%output %0 data\r\n");
        match r.next_event() {
            Some(CcEvent::Output { data, .. }) => assert_eq!(data, b"data"),
            other => panic!("expected Output (window-close should be ignored), got {:?}", other.is_some()),
        }
    }

    #[test]
    fn test_reader_unlinked_other_window_emits_other_closed() {
        // tmux routes %unlinked-window-close events to OTHER grouped clients,
        // not the pane whose window was destroyed.  So the case that fires in
        // production is "different window id from ours" — we must surface this
        // as an event the caller can route, not silently drop it.
        let mut r = CcReader::new("%0".to_string());
        r.set_window_id("@1".to_string());
        r.feed(b"%unlinked-window-close @2\r\n%output %0 data\r\n");
        match r.next_event() {
            Some(CcEvent::OtherWindowClosed { window_id }) => assert_eq!(window_id, "@2"),
            other => panic!("expected OtherWindowClosed, got {:?}", other.is_some()),
        }
        match r.next_event() {
            Some(CcEvent::Output { data, .. }) => assert_eq!(data, b"data"),
            other => panic!("expected Output after OtherWindowClosed, got {:?}", other.is_some()),
        }
    }

    #[test]
    fn test_reader_unlinked_no_window_id_emits_other_closed() {
        // With no window_id set we can't match "ours", so the close must
        // still surface as OtherWindowClosed so a registry-based router can
        // dispatch it to whoever does own that window.
        let mut r = CcReader::new("%0".to_string());
        r.feed(b"%unlinked-window-close @7\r\n%output %0 data\r\n");
        match r.next_event() {
            Some(CcEvent::OtherWindowClosed { window_id }) => assert_eq!(window_id, "@7"),
            other => panic!("expected OtherWindowClosed, got {:?}", other.is_some()),
        }
        match r.next_event() {
            Some(CcEvent::Output { data, .. }) => assert_eq!(data, b"data"),
            other => panic!("expected Output, got {:?}", other.is_some()),
        }
    }

    // --- window close registry ---

    #[actix_web::test]
    async fn test_registry_notifies_registered_window() {
        let notify = register_window_close("@ntest1".to_string());
        // Simulate another reader seeing our window get unlinked
        notify_window_closed("@ntest1");
        tokio::time::timeout(std::time::Duration::from_millis(100), notify.notified())
            .await
            .expect("expected notification to fire");
        unregister_window_close("@ntest1");
    }

    #[actix_web::test]
    async fn test_registry_ignores_unregistered_window() {
        // Calling notify on an unregistered id is a no-op (doesn't panic).
        notify_window_closed("@never-registered");
    }

    #[actix_web::test]
    async fn test_reader_and_registry_route_close_across_readers() {
        // Simulates real tmux behavior: pane A's window is destroyed.
        // Pane A's own reader sees nothing (or %exit, handled elsewhere).
        // Pane B's reader sees `%unlinked-window-close @A_window`, emits
        // OtherWindowClosed, and the caller routes it to A via the registry.
        let a_notify = register_window_close("@route-A".to_string());

        let mut reader_b = CcReader::new("%B".to_string());
        reader_b.set_window_id("@route-B".to_string());
        reader_b.feed(b"%unlinked-window-close @route-A\r\n");
        match reader_b.next_event() {
            Some(CcEvent::OtherWindowClosed { window_id }) => {
                notify_window_closed(&window_id);
            }
            other => panic!("expected OtherWindowClosed, got {:?}", other.is_some()),
        }

        tokio::time::timeout(std::time::Duration::from_millis(100), a_notify.notified())
            .await
            .expect("expected A's notify to fire after B observed A's close");
        unregister_window_close("@route-A");
    }

    #[actix_web::test]
    async fn test_registry_unregister_stops_notifications() {
        let notify = register_window_close("@ntest2".to_string());
        unregister_window_close("@ntest2");
        notify_window_closed("@ntest2");
        // Should NOT fire within a short window (registration was dropped)
        let timed_out = tokio::time::timeout(
            std::time::Duration::from_millis(50),
            notify.notified(),
        )
        .await
        .is_err();
        assert!(timed_out, "notification fired after unregister");
    }

    /// %exit must produce CcEvent::Exit (NOT WindowClosed), even when a
    /// window_id is set.  The linked session can be killed during reconnection
    /// cleanup — that sends %exit but the pane is still alive.  Treating it
    /// as WindowClosed would auto-close the browser tab.
    #[test]
    fn test_reader_exit_is_not_window_closed() {
        let mut r = CcReader::new("%0".to_string());
        r.set_window_id("@1".to_string());
        r.feed(b"%exit\r\n");
        match r.next_event() {
            Some(CcEvent::Exit) => {} // correct — generic exit, not a window close
            Some(CcEvent::WindowClosed) => panic!("%exit must not produce WindowClosed"),
            other => panic!("expected Exit, got {:?}", other.is_some()),
        }
    }

    #[test]
    fn test_reader_partial_line() {
        let mut r = CcReader::new("%0".to_string());
        r.feed(b"%output %0 hel");
        assert!(r.next_event().is_none());
        r.feed(b"lo\r\n");
        match r.next_event() {
            Some(CcEvent::Output { data, .. }) => assert_eq!(data, b"hello"),
            other => panic!("expected Output, got {:?}", other.is_some()),
        }
    }

    #[test]
    fn test_reader_skips_notifications() {
        let mut r = CcReader::new("%0".to_string());
        r.feed(b"%begin 123 0 0\r\n%end 123 0 0\r\n%session-changed $0 foo\r\n%output %0 data\r\n");
        match r.next_event() {
            Some(CcEvent::Output { data, .. }) => assert_eq!(data, b"data"),
            other => panic!("expected Output, got {:?}", other.is_some()),
        }
    }

    #[test]
    fn test_reader_dcs_prefix_stripped() {
        let mut r = CcReader::new("%0".to_string());
        r.feed(b"\x1bP1000p%begin 123 0 0\r\n%end 123 0 0\r\n%output %0 ok\r\n");
        match r.next_event() {
            Some(CcEvent::Output { data, .. }) => assert_eq!(data, b"ok"),
            other => panic!("expected Output, got {:?}", other.is_some()),
        }
    }

    // -- alternate screen tracking --

    #[test]
    fn test_reader_alternate_screen_enable() {
        let mut r = CcReader::new("%0".to_string());
        assert!(!r.alternate_screen());
        // \e[?1049h encoded as octal in %output
        r.feed(b"%output %0 \\033[?1049h\r\n");
        match r.next_event() {
            Some(CcEvent::Output { alternate_screen, .. }) => assert!(alternate_screen),
            _ => panic!("expected Output"),
        }
        assert!(r.alternate_screen());
    }

    #[test]
    fn test_reader_alternate_screen_disable() {
        let mut r = CcReader::new("%0".to_string());
        // Enable then disable
        r.feed(b"%output %0 \\033[?1049h\r\n%output %0 \\033[?1049l\r\n");
        r.next_event(); // enable
        match r.next_event() {
            Some(CcEvent::Output { alternate_screen, .. }) => assert!(!alternate_screen),
            _ => panic!("expected Output"),
        }
        assert!(!r.alternate_screen());
    }

    #[test]
    fn test_reader_alternate_screen_not_triggered_by_normal_output() {
        let mut r = CcReader::new("%0".to_string());
        r.feed(b"%output %0 hello world\r\n");
        match r.next_event() {
            Some(CcEvent::Output { alternate_screen, .. }) => assert!(!alternate_screen),
            _ => panic!("expected Output"),
        }
    }

    #[test]
    fn test_reader_alternate_screen_last_wins() {
        let mut r = CcReader::new("%0".to_string());
        // disable then enable in same chunk — enable should win
        r.feed(b"%output %0 \\033[?1049l\\015\\033[?1049h\r\n");
        match r.next_event() {
            Some(CcEvent::Output { alternate_screen, .. }) => assert!(alternate_screen),
            _ => panic!("expected Output"),
        }
    }

    // -- mouse tracking stripped from output --

    #[test]
    fn test_reader_strips_mouse_tracking_from_output() {
        let mut r = CcReader::new("%0".to_string());
        // Feed %output containing mouse tracking enable sequences
        // (as tmux would send when emacs enables mouse)
        r.feed(b"%output %0 \\033[?1000h\\033[?1002h\\033[?1006hHello\r\n");
        match r.next_event() {
            Some(CcEvent::Output { data, .. }) => {
                // The output should NOT contain mouse tracking sequences
                assert!(!data.windows(8).any(|w| w == b"\x1b[?1000h"),
                    "output should not contain \\e[?1000h: {:?}", String::from_utf8_lossy(&data));
                assert!(!data.windows(8).any(|w| w == b"\x1b[?1002h"),
                    "output should not contain \\e[?1002h");
                assert!(!data.windows(8).any(|w| w == b"\x1b[?1006h"),
                    "output should not contain \\e[?1006h");
                // But the actual content should still be there
                assert!(data.windows(5).any(|w| w == b"Hello"),
                    "output should still contain Hello");
            }
            _ => panic!("expected Output"),
        }
    }

    #[test]
    fn test_reader_strips_clear_scrollback_from_output() {
        let mut r = CcReader::new("%0".to_string());
        // Feed %output containing \e[3J (clear scrollback) mixed with content.
        // In tmux octal encoding: \033 = ESC, [3J is literal.
        r.feed(b"%output %0 \\033[3JHello\r\n");
        match r.next_event() {
            Some(CcEvent::Output { data, .. }) => {
                assert!(!data.windows(4).any(|w| w == b"\x1b[3J"),
                    "output should not contain \\e[3J: {:?}", String::from_utf8_lossy(&data));
                assert!(data.windows(5).any(|w| w == b"Hello"),
                    "output should still contain Hello");
            }
            _ => panic!("expected Output"),
        }
    }

    // -- filter_escapes --

    #[test]
    fn test_strip_mouse_tracking() {
        assert_eq!(filter_escapes(b"\x1b[?1000h", false), b"");
        assert_eq!(filter_escapes(b"\x1b[?1002h", false), b"");
        assert_eq!(filter_escapes(b"\x1b[?1003h", false), b"");
        assert_eq!(filter_escapes(b"\x1b[?1006h", false), b"");
        assert_eq!(filter_escapes(b"\x1b[?1000l", false), b"");
    }

    #[test]
    fn test_pass_mouse_preserves_tracking() {
        assert_eq!(filter_escapes(b"\x1b[?1000h", true), b"\x1b[?1000h");
        assert_eq!(filter_escapes(b"\x1b[?1006h", true), b"\x1b[?1006h");
    }

    #[test]
    fn test_strip_mouse_preserves_other() {
        assert_eq!(filter_escapes(b"hello", false), b"hello");
        assert_eq!(filter_escapes(b"\x1b[31m", false), b"\x1b[31m");
        assert_eq!(filter_escapes(b"\x1b[?1049h", false), b"\x1b[?1049h");
    }

    #[test]
    fn test_strip_mouse_mixed() {
        let input = b"\x1b[?1049h\x1b[?1000h\x1b[?1002hHello\x1b[?1006h";
        assert_eq!(filter_escapes(input, false), b"\x1b[?1049hHello");
        assert_eq!(filter_escapes(input, true), input.as_slice());
    }

    // -- clear scrollback (\e[3J) stripped from output --

    #[test]
    fn test_strip_clear_scrollback() {
        assert_eq!(filter_escapes(b"\x1b[3J", false), b"");
    }

    #[test]
    fn test_strip_clear_scrollback_with_content() {
        assert_eq!(filter_escapes(b"hello\x1b[3Jworld", false), b"helloworld");
    }

    #[test]
    fn test_erase_display_passes_through() {
        // \e[2J (erase display) must pass through — it's needed for repaint.
        // The scrollback pollution comes from Claude writing 100+ lines that
        // overflow the viewport, not from this sequence.
        assert_eq!(filter_escapes(b"\x1b[2J", false), b"\x1b[2J");
    }

    #[test]
    fn test_erase_display_with_content() {
        assert_eq!(filter_escapes(b"hello\x1b[2Jworld", false), b"hello\x1b[2Jworld");
    }

    #[test]
    fn test_full_clear_combo() {
        // `clear` sends \e[H\e[2J\e[3J — \e[3J passes through because
        // it immediately follows \e[2J (full-redraw cleanup pattern)
        let input = b"\x1b[H\x1b[2J\x1b[3J";
        let expected = b"\x1b[H\x1b[2J\x1b[3J";
        assert_eq!(filter_escapes(input, false), expected);
    }

    #[test]
    fn test_claude_repaint_lets_3j_through() {
        // Claude sends \e[2J\e[3J\e[H — the \e[3J must pass through when
        // paired with \e[2J so scrollback gets cleaned up after each full
        // redraw. Without this, Claude's 100+ line redraws overflow the
        // viewport and accumulate duplicate frames in scrollback.
        let input = b"\x1b[2J\x1b[3J\x1b[H";
        let expected = b"\x1b[2J\x1b[3J\x1b[H";
        assert_eq!(filter_escapes(input, false), expected);
    }

    #[test]
    fn test_standalone_3j_still_stripped() {
        // \e[3J without preceding \e[2J should still be stripped
        // (e.g., from `clear` command or incremental sync blocks)
        assert_eq!(filter_escapes(b"\x1b[3J", false), b"");
        assert_eq!(filter_escapes(b"hello\x1b[3Jworld", false), b"helloworld");
    }

    #[test]
    fn test_3j_after_gap_still_stripped() {
        // \e[3J separated from \e[2J by other content should be stripped
        assert_eq!(
            filter_escapes(b"\x1b[2Jhello\x1b[3J", false),
            b"\x1b[2Jhello"
        );
    }

    // -- CcWriter --

    #[test]
    fn test_writer_input() {
        let w = CcWriter::new("%0".to_string());
        assert_eq!(w.input(b"A"), b"send-keys -H -t %0 41\n");
    }

    #[test]
    fn test_writer_resize() {
        let w = CcWriter::new("%0".to_string());
        assert_eq!(w.resize(80, 24), b"refresh-client -C 80,24\n");
    }
}

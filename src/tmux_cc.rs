//! tmux control mode (-C) protocol handling.
//!
//! Provides encoding/decoding for the tmux control mode protocol,
//! plus `CcReader` (protocol parser) and `CcWriter` (command encoder).

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
pub fn encode_input(pane_id: &str, data: &[u8]) -> Vec<u8> {
    let mut cmd = format!("send-keys -H -t {pane_id}");
    for byte in data {
        cmd.push_str(&format!(" {:02x}", byte));
    }
    cmd.push('\n');
    cmd.into_bytes()
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

// -- CcReader: protocol parser --

/// Events produced by `CcReader` when parsing tmux control mode output.
pub enum CcEvent {
    /// Decoded terminal output bytes for the target pane.
    Output(Vec<u8>),
    /// The tmux control client is exiting.
    Exit,
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
    saw_exit: bool,
}

impl CcReader {
    pub fn new(pane_id: String) -> Self {
        Self {
            line_buf: Vec::with_capacity(8192),
            dcs_stripped: false,
            pane_id,
            saw_exit: false,
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
                            return Some(CcEvent::Output(decoded));
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
            Some(CcEvent::Output(data)) => assert_eq!(data, b"hello\r\n"),
            other => panic!("expected Output, got {:?}", other.is_some()),
        }
        assert!(r.next_event().is_none());
    }

    #[test]
    fn test_reader_filters_other_pane() {
        let mut r = CcReader::new("%0".to_string());
        r.feed(b"%output %1 ignored\r\n%output %0 mine\r\n");
        match r.next_event() {
            Some(CcEvent::Output(data)) => assert_eq!(data, b"mine"),
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
    fn test_reader_partial_line() {
        let mut r = CcReader::new("%0".to_string());
        r.feed(b"%output %0 hel");
        assert!(r.next_event().is_none());
        r.feed(b"lo\r\n");
        match r.next_event() {
            Some(CcEvent::Output(data)) => assert_eq!(data, b"hello"),
            other => panic!("expected Output, got {:?}", other.is_some()),
        }
    }

    #[test]
    fn test_reader_skips_notifications() {
        let mut r = CcReader::new("%0".to_string());
        r.feed(b"%begin 123 0 0\r\n%end 123 0 0\r\n%session-changed $0 foo\r\n%output %0 data\r\n");
        match r.next_event() {
            Some(CcEvent::Output(data)) => assert_eq!(data, b"data"),
            other => panic!("expected Output, got {:?}", other.is_some()),
        }
    }

    #[test]
    fn test_reader_dcs_prefix_stripped() {
        let mut r = CcReader::new("%0".to_string());
        r.feed(b"\x1bP1000p%begin 123 0 0\r\n%end 123 0 0\r\n%output %0 ok\r\n");
        match r.next_event() {
            Some(CcEvent::Output(data)) => assert_eq!(data, b"ok"),
            other => panic!("expected Output, got {:?}", other.is_some()),
        }
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

# Default agentdispatch build.sh — runs during workspace initialization.
# Do not edit — this file is managed by agentdispatch.
# Override by creating .agentdispatch/build.sh in your project or its parent.
set -e

if [ "$1" = "--list" ]; then
    # No build variants available by default
    exit 0
fi

WORKTREE="${2:-.}"
cd "$WORKTREE"

# Init submodules if the project uses them (best-effort)
if [ -f .gitmodules ]; then
    echo "Initializing submodules..."
    if ! git submodule update --init --recursive 2>/tmp/submodule-err-$$.log; then
        echo "Warning: submodule init failed (cleaning up broken refs)"
        cat /tmp/submodule-err-$$.log
        # Clean up broken .git files pointing to incomplete gitdirs
        find . -name .git -type f | while read f; do
            dir=$(sed 's/gitdir: //' "$f")
            if [ ! -f "$(dirname "$f")/$dir/HEAD" ]; then
                echo "Removing broken submodule ref: $f"
                rm -f "$f"
            fi
        done
        rm -f /tmp/submodule-err-$$.log
    fi
fi

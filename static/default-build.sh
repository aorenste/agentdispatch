# Default agentdispatch build.sh — runs during workspace initialization.
# Do not edit — this file is managed by agentdispatch.
# Override by creating .agentdispatch/build.sh in your project or its parent.
set -e

if [ "$1" = "--list" ]; then
    # No build variants available by default
    exit 0
fi

# No-op build — override with a project-specific build.sh

# Default agentdispatch bash.sh — sourced as rcfile for all tmux panes.
# Do not edit — this file is managed by agentdispatch.
source ~/.bashrc

# Activate conda env if configured in project settings
if [ -n "$AGENTDISPATCH_CONDA_ENV" ]; then
    eval "$(conda shell.bash hook)" 2>/dev/null
    conda activate "$AGENTDISPATCH_CONDA_ENV" 2>/dev/null || \
        echo "WARNING: Failed to activate conda env $AGENTDISPATCH_CONDA_ENV" >&2
fi

# Source project-specific bash.sh if it exists
if [ -n "$AGENTDISPATCH_PROJECT_BASH" ] && [ -f "$AGENTDISPATCH_PROJECT_BASH" ]; then
    source "$AGENTDISPATCH_PROJECT_BASH"
fi

# Launch agent or stay in interactive shell
if [ "$AGENTDISPATCH_ACTION" = "claude" ] && [ -n "$AGENTDISPATCH_AGENT_CMD" ]; then
    eval "$AGENTDISPATCH_AGENT_CMD"
fi

// Must be imported before any module that creates a chalk instance: chalk
// reads color support at evaluation time, and the harness runs without a TTY.
process.env.FORCE_COLOR = "3";

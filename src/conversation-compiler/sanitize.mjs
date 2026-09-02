// Keep sanitization deliberately conservative: normalize transport newlines,
// remove terminal escapes/control bytes, and retain semantic spacing/markup.
const ANSI_ESCAPE_RE = /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f]/g;

export const sanitize = (text) => String(text ?? "")
  .replace(/\r\n?/g, "\n")
  .replace(ANSI_ESCAPE_RE, "")
  .replace(CONTROL_RE, "")
  .trim();

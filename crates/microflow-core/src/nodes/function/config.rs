//! Function Node config — shared by the live runtime and the codegen emitter.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FunctionConfig {
    /// User-authored JS body. Receives `input`; must return a value. The
    /// runtime wraps it as `(function(input) { <code> })(input)`; the emitter
    /// translates the supported subset to one C++ expression.
    #[serde(default = "default_code")]
    pub(crate) code: String,
}

fn default_code() -> String {
    "// Transform the input value and return the result\n// Use {{varName}} to reference connected handle values\nconst value = input;\nreturn value;".to_string()
}

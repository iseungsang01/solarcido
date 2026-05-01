use std::fmt::{Display, Formatter};
use std::time::Duration;

const CONTEXT_WINDOW_ERROR_MARKERS: &[&str] = &[
    "maximum context length",
    "context window",
    "context length",
    "too many tokens",
    "prompt is too long",
    "input is too long",
    "request is too large",
];

#[derive(Debug)]
pub enum ApiError {
    MissingCredentials {
        provider: &'static str,
        env_vars: &'static [&'static str],
        hint: Option<String>,
    },
    ContextWindowExceeded {
        model: String,
        estimated_input_tokens: u32,
        requested_output_tokens: u32,
        estimated_total_tokens: u32,
        context_window_tokens: u32,
    },
    Http(reqwest::Error),
    Io(std::io::Error),
    Json {
        provider: String,
        model: String,
        body_snippet: String,
        source: serde_json::Error,
    },
    Api {
        status: reqwest::StatusCode,
        error_type: Option<String>,
        message: Option<String>,
        request_id: Option<String>,
        body: String,
        retryable: bool,
        suggested_action: Option<String>,
    },
    RetriesExhausted {
        attempts: u32,
        last_error: Box<ApiError>,
    },
    InvalidSseFrame(&'static str),
    BackoffOverflow {
        attempt: u32,
        base_delay: Duration,
    },
    RequestBodySizeExceeded {
        estimated_bytes: usize,
        max_bytes: usize,
        provider: &'static str,
    },
}

impl ApiError {
    #[must_use]
    pub const fn missing_credentials(
        provider: &'static str,
        env_vars: &'static [&'static str],
    ) -> Self {
        Self::MissingCredentials {
            provider,
            env_vars,
            hint: None,
        }
    }

    #[must_use]
    pub fn missing_credentials_with_hint(
        provider: &'static str,
        env_vars: &'static [&'static str],
        hint: impl Into<String>,
    ) -> Self {
        Self::MissingCredentials {
            provider,
            env_vars,
            hint: Some(hint.into()),
        }
    }

    #[must_use]
    pub fn json_deserialize(
        provider: impl Into<String>,
        model: impl Into<String>,
        body: &str,
        source: serde_json::Error,
    ) -> Self {
        Self::Json {
            provider: provider.into(),
            model: model.into(),
            body_snippet: truncate_body_snippet(body, 200),
            source,
        }
    }

    #[must_use]
    pub fn is_retryable(&self) -> bool {
        match self {
            Self::Http(error) => error.is_connect() || error.is_timeout() || error.is_request(),
            Self::Api { retryable, .. } => *retryable,
            Self::RetriesExhausted { last_error, .. } => last_error.is_retryable(),
            Self::MissingCredentials { .. }
            | Self::ContextWindowExceeded { .. }
            | Self::Io(_)
            | Self::Json { .. }
            | Self::InvalidSseFrame(_)
            | Self::BackoffOverflow { .. }
            | Self::RequestBodySizeExceeded { .. } => false,
        }
    }

    #[must_use]
    pub fn request_id(&self) -> Option<&str> {
        match self {
            Self::Api { request_id, .. } => request_id.as_deref(),
            Self::RetriesExhausted { last_error, .. } => last_error.request_id(),
            _ => None,
        }
    }

    #[must_use]
    pub fn safe_failure_class(&self) -> &'static str {
        match self {
            Self::RetriesExhausted { .. } if self.is_context_window_failure() => "context_window",
            Self::RetriesExhausted { last_error, .. } => last_error.safe_failure_class(),
            Self::MissingCredentials { .. } => "provider_auth",
            Self::Api { status, .. } if matches!(status.as_u16(), 401 | 403) => "provider_auth",
            Self::ContextWindowExceeded { .. } => "context_window",
            Self::Api { .. } if self.is_context_window_failure() => "context_window",
            Self::Api { status, .. } if status.as_u16() == 429 => "provider_rate_limit",
            Self::Api { .. } => "provider_error",
            Self::Http(_) | Self::InvalidSseFrame(_) | Self::BackoffOverflow { .. } => {
                "provider_transport"
            }
            Self::Io(_) | Self::Json { .. } => "runtime_io",
            Self::RequestBodySizeExceeded { .. } => "request_size",
        }
    }

    #[must_use]
    pub fn is_context_window_failure(&self) -> bool {
        match self {
            Self::ContextWindowExceeded { .. } => true,
            Self::Api {
                status,
                message,
                body,
                ..
            } => {
                matches!(status.as_u16(), 400 | 413 | 422)
                    && (message
                        .as_deref()
                        .is_some_and(looks_like_context_window_error)
                        || looks_like_context_window_error(body))
            }
            Self::RetriesExhausted { last_error, .. } => last_error.is_context_window_failure(),
            _ => false,
        }
    }
}

impl Display for ApiError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MissingCredentials {
                provider,
                env_vars,
                hint,
            } => {
                write!(
                    f,
                    "missing {provider} credentials; export {} before calling the {provider} API",
                    env_vars.join(" or ")
                )?;
                if let Some(hint) = hint {
                    write!(f, " — hint: {hint}")?;
                }
                Ok(())
            }
            Self::ContextWindowExceeded {
                model,
                estimated_input_tokens,
                requested_output_tokens,
                estimated_total_tokens,
                context_window_tokens,
            } => write!(
                f,
                "context_window_blocked for {model}: estimated input {estimated_input_tokens} + requested output {requested_output_tokens} = {estimated_total_tokens} tokens exceeds the {context_window_tokens}-token context window; compact the session or reduce request size before retrying"
            ),
            Self::Http(error) => write!(f, "http error: {error}"),
            Self::Io(error) => write!(f, "io error: {error}"),
            Self::Json {
                provider,
                model,
                body_snippet,
                source,
            } => write!(
                f,
                "failed to parse {provider} response for model {model}: {source}; first 200 chars of body: {body_snippet}"
            ),
            Self::Api {
                status,
                error_type,
                message,
                request_id,
                body,
                ..
            } => {
                if let (Some(error_type), Some(message)) = (error_type, message) {
                    write!(f, "api returned {status} ({error_type})")?;
                    if let Some(request_id) = request_id {
                        write!(f, " [trace {request_id}]")?;
                    }
                    write!(f, ": {message}")
                } else {
                    write!(f, "api returned {status}")?;
                    if let Some(request_id) = request_id {
                        write!(f, " [trace {request_id}]")?;
                    }
                    write!(f, ": {body}")
                }
            }
            Self::RetriesExhausted {
                attempts,
                last_error,
            } => write!(f, "api failed after {attempts} attempts: {last_error}"),
            Self::InvalidSseFrame(message) => write!(f, "invalid sse frame: {message}"),
            Self::BackoffOverflow {
                attempt,
                base_delay,
            } => write!(
                f,
                "retry backoff overflowed on attempt {attempt} with base delay {base_delay:?}"
            ),
            Self::RequestBodySizeExceeded {
                estimated_bytes,
                max_bytes,
                provider,
            } => write!(
                f,
                "request body size ({estimated_bytes} bytes) exceeds {provider} limit ({max_bytes} bytes); reduce prompt length or context before retrying"
            ),
        }
    }
}

impl std::error::Error for ApiError {}

impl From<reqwest::Error> for ApiError {
    fn from(value: reqwest::Error) -> Self {
        Self::Http(value)
    }
}

impl From<std::io::Error> for ApiError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value)
    }
}

impl From<serde_json::Error> for ApiError {
    fn from(value: serde_json::Error) -> Self {
        Self::Json {
            provider: "unknown".to_string(),
            model: "unknown".to_string(),
            body_snippet: String::new(),
            source: value,
        }
    }
}

/// Suggested user action based on HTTP status code.
#[must_use]
pub fn suggested_action_for_status(status: reqwest::StatusCode) -> Option<String> {
    match status.as_u16() {
        401 => Some("Check API key is set correctly and has not expired".to_string()),
        403 => Some("Verify API key has required permissions for this operation".to_string()),
        413 => Some("Reduce prompt size or context window before retrying".to_string()),
        429 => Some("Wait a moment before retrying; consider reducing request rate".to_string()),
        500 => Some("Provider server error — retry after a brief wait".to_string()),
        502..=504 => Some("Provider gateway error — retry after a brief wait".to_string()),
        _ => None,
    }
}

fn truncate_body_snippet(body: &str, max_chars: usize) -> String {
    let mut taken = 0;
    let mut byte_end = 0;
    for (offset, ch) in body.char_indices() {
        if taken >= max_chars {
            break;
        }
        taken += 1;
        byte_end = offset + ch.len_utf8();
    }
    if taken >= max_chars && byte_end < body.len() {
        format!("{}…", &body[..byte_end])
    } else {
        body[..byte_end].to_string()
    }
}

fn looks_like_context_window_error(text: &str) -> bool {
    let lowered = text.to_ascii_lowercase();
    CONTEXT_WINDOW_ERROR_MARKERS
        .iter()
        .any(|marker| lowered.contains(marker))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_keeps_short_bodies() {
        assert_eq!(truncate_body_snippet("hello", 200), "hello");
        assert_eq!(truncate_body_snippet("", 200), "");
    }

    #[test]
    fn truncate_caps_long_bodies() {
        let body = "a".repeat(250);
        let snippet = truncate_body_snippet(&body, 200);
        assert_eq!(snippet.chars().count(), 201);
        assert!(snippet.ends_with('…'));
    }

    #[test]
    fn truncate_preserves_multibyte() {
        let snippet = truncate_body_snippet("한글한글한글한글한글한글", 4);
        assert_eq!(snippet, "한글한글…");
    }

    #[test]
    fn missing_credentials_display() {
        let err = ApiError::missing_credentials("Upstage", &["UPSTAGE_API_KEY"]);
        let rendered = err.to_string();
        assert!(rendered.contains("missing Upstage credentials"));
        assert!(rendered.contains("UPSTAGE_API_KEY"));
    }

    #[test]
    fn api_error_classification() {
        let err = ApiError::Api {
            status: reqwest::StatusCode::BAD_REQUEST,
            error_type: Some("invalid_request_error".to_string()),
            message: Some("maximum context length exceeded".to_string()),
            request_id: None,
            body: String::new(),
            retryable: false,
            suggested_action: None,
        };
        assert!(err.is_context_window_failure());
        assert_eq!(err.safe_failure_class(), "context_window");
        assert!(!err.is_retryable());
    }

    #[test]
    fn retries_exhausted_propagates() {
        let err = ApiError::RetriesExhausted {
            attempts: 3,
            last_error: Box::new(ApiError::Api {
                status: reqwest::StatusCode::BAD_GATEWAY,
                error_type: None,
                message: None,
                request_id: Some("req_123".to_string()),
                body: "bad gateway".to_string(),
                retryable: true,
                suggested_action: None,
            }),
        };
        assert_eq!(err.request_id(), Some("req_123"));
        assert_eq!(err.safe_failure_class(), "provider_error");
    }
}

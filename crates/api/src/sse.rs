//! SSE (Server-Sent Events) frame parser for OpenAI-compatible streaming.
//!
//! Buffers byte chunks from an HTTP response body and yields complete SSE
//! data payloads as raw strings. The higher-level client module handles
//! deserialization into typed events.

use crate::error::ApiError;

/// Incremental SSE parser that buffers partial frames across chunk boundaries.
#[derive(Debug, Default)]
pub struct SseParser {
    buffer: Vec<u8>,
}

impl SseParser {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Push a raw byte chunk and return any complete SSE data payloads.
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<String>, ApiError> {
        self.buffer.extend_from_slice(chunk);
        let mut events = Vec::new();
        while let Some(frame) = self.next_frame() {
            if let Some(payload) = extract_data_payload(&frame)? {
                events.push(payload);
            }
        }
        Ok(events)
    }

    /// Drain any trailing buffered data after the response body ends.
    pub fn finish(&mut self) -> Result<Vec<String>, ApiError> {
        if self.buffer.is_empty() {
            return Ok(Vec::new());
        }
        let trailing = std::mem::take(&mut self.buffer);
        let text = String::from_utf8_lossy(&trailing);
        match extract_data_payload(text.trim())? {
            Some(payload) => Ok(vec![payload]),
            None => Ok(Vec::new()),
        }
    }

    fn next_frame(&mut self) -> Option<String> {
        let separator = self
            .buffer
            .windows(2)
            .position(|w| w == b"\n\n")
            .map(|pos| (pos, 2))
            .or_else(|| {
                self.buffer
                    .windows(4)
                    .position(|w| w == b"\r\n\r\n")
                    .map(|pos| (pos, 4))
            })?;

        let (position, sep_len) = separator;
        let frame_bytes: Vec<u8> = self.buffer.drain(..position + sep_len).collect();
        let frame_len = frame_bytes.len().saturating_sub(sep_len);
        Some(String::from_utf8_lossy(&frame_bytes[..frame_len]).into_owned())
    }
}

/// Extract the data payload from an SSE frame. Returns `None` for empty frames,
/// comment-only frames, and `[DONE]` sentinels.
fn extract_data_payload(frame: &str) -> Result<Option<String>, ApiError> {
    let trimmed = frame.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    let mut data_lines = Vec::new();
    for line in trimmed.lines() {
        if line.starts_with(':') {
            continue;
        }
        if let Some(data) = line.strip_prefix("data:") {
            data_lines.push(data.trim_start());
        }
    }

    if data_lines.is_empty() {
        return Ok(None);
    }

    let payload = data_lines.join("\n");
    if payload == "[DONE]" {
        return Ok(None);
    }

    Ok(Some(payload))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_single_frame() {
        let frame = "data: {\"id\":\"x\",\"content\":\"Hi\"}\n\n";
        let mut parser = SseParser::new();
        let events = parser.push(frame.as_bytes()).unwrap();
        assert_eq!(events.len(), 1);
        assert!(events[0].contains("\"id\":\"x\""));
    }

    #[test]
    fn handles_chunked_delivery() {
        let mut parser = SseParser::new();
        let first = b"data: {\"id\":\"x\",\"content\":\"Hel";
        let second = b"lo\"}\n\n";

        assert!(parser.push(first).unwrap().is_empty());
        let events = parser.push(second).unwrap();
        assert_eq!(events.len(), 1);
        assert!(events[0].contains("Hello"));
    }

    #[test]
    fn ignores_done_and_comments() {
        let mut parser = SseParser::new();
        let payload = ": keepalive\n\ndata: [DONE]\n\n";
        let events = parser.push(payload.as_bytes()).unwrap();
        assert!(events.is_empty());
    }

    #[test]
    fn extracts_multiple_frames() {
        let mut parser = SseParser::new();
        let payload = "data: {\"a\":1}\n\ndata: {\"b\":2}\n\n";
        let events = parser.push(payload.as_bytes()).unwrap();
        assert_eq!(events.len(), 2);
    }
}

use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(45);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiConfig {
    pub provider: String, // "embedded" | "ollama" | "custom" | "openai"
    pub endpoint: String, // e.g. "http://127.0.0.1:11434"
    pub model: String,    // e.g. "qwen2.5-coder:0.5b"
    pub api_key: Option<String>,
    pub temperature: Option<f32>,
}

impl Default for AiConfig {
    fn default() -> Self {
        Self {
            provider: "embedded".to_string(),
            endpoint: "http://127.0.0.1:11434".to_string(),
            model: "qwen2.5-coder:0.5b".to_string(),
            api_key: None,
            temperature: Some(0.2),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiStatus {
    pub ok: bool,
    pub message: String,
    pub latency_ms: u64,
    pub models: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GeneratedCommit {
    pub full_message: String,
    pub commit_type: Option<String>,
    pub scope: Option<String>,
    pub subject: String,
    pub body: Option<String>,
    pub breaking: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GeneratedPr {
    pub title: String,
    pub body: String,
}

fn create_agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout(DEFAULT_TIMEOUT)
        .build()
}

fn validate_endpoint(endpoint: &str) -> AppResult<String> {
    let trimmed = endpoint.trim().trim_end_matches('/');
    let normalized = if !trimmed.starts_with("http://") && !trimmed.starts_with("https://") {
        format!("http://{trimmed}")
    } else {
        trimmed.to_string()
    };

    let lower = normalized.to_lowercase();
    if lower.contains("169.254.169.254")
        || lower.contains("metadata.google.internal")
        || lower.contains("fd00:ec2::254")
    {
        return Err(crate::error::AppError::Msg(
            "Access to cloud metadata endpoints is restricted for security.".into(),
        ));
    }

    Ok(normalized)
}

/// Tests connectivity to the configured AI provider and lists installed/available models.
pub fn test_connection(app: &tauri::AppHandle, config: &AiConfig) -> AppResult<AiStatus> {
    let start = Instant::now();

    if config.provider == "embedded" || config.provider == "local" {
        let status = super::embedded::get_status(app)?;
        if status.installed {
            return Ok(AiStatus {
                ok: true,
                message: format!(
                    "Chef AI Local Model Ready (Qwen 2.5 Coder 0.5B, {:.1} MB)",
                    status.file_size_bytes as f64 / 1_000_000.0
                ),
                latency_ms: 0,
                models: vec!["qwen2.5-coder:0.5b".into()],
            });
        } else if status.downloading {
            return Ok(AiStatus {
                ok: false,
                message: format!("Downloading model ({:.0}%)...", status.progress_percent),
                latency_ms: 0,
                models: vec![],
            });
        } else {
            return Ok(AiStatus {
                ok: false,
                message: "Local model not downloaded yet. Click 'Download & Enable (390 MB)' to activate 1-click AI.".into(),
                latency_ms: 0,
                models: vec![],
            });
        }
    }

    let base_url = match validate_endpoint(&config.endpoint) {
        Ok(u) => u,
        Err(e) => {
            return Ok(AiStatus {
                ok: false,
                message: e.to_string(),
                latency_ms: 0,
                models: Vec::new(),
            });
        }
    };
    let agent = create_agent();

    if config.provider == "ollama" {
        let tags_url = format!("{base_url}/api/tags");
        let resp = match agent.get(&tags_url).call() {
            Ok(r) => r,
            Err(ureq::Error::Status(code, resp)) => {
                let text = resp.into_string().unwrap_or_default();
                return Ok(AiStatus {
                    ok: false,
                    message: format!("Ollama returned HTTP {code}: {text}"),
                    latency_ms: start.elapsed().as_millis() as u64,
                    models: Vec::new(),
                });
            }
            Err(e) => {
                return Ok(AiStatus {
                    ok: false,
                    message: format!(
                        "Could not connect to Ollama at {base_url}. Ensure 'ollama serve' is running. ({e})"
                    ),
                    latency_ms: start.elapsed().as_millis() as u64,
                    models: Vec::new(),
                });
            }
        };

        #[derive(Deserialize)]
        struct TagModel {
            name: String,
        }
        #[derive(Deserialize)]
        struct TagsResponse {
            models: Option<Vec<TagModel>>,
        }

        let tags: TagsResponse = resp
            .into_json()
            .map_err(|e| AppError::Msg(format!("Invalid Ollama tags response: {e}")))?;

        let models = tags
            .models
            .unwrap_or_default()
            .into_iter()
            .map(|m| m.name)
            .collect::<Vec<_>>();

        let latency = start.elapsed().as_millis() as u64;
        let model_count = models.len();
        let message = if model_count > 0 {
            format!("Connected to Ollama ({latency}ms, {model_count} model(s) available)")
        } else {
            format!("Connected to Ollama ({latency}ms), but no models found. Run `ollama pull qwen2.5-coder:0.5b`")
        };

        Ok(AiStatus {
            ok: true,
            message,
            latency_ms: latency,
            models,
        })
    } else {
        // OpenAI / compatible endpoint (/v1/models)
        let models_url = if base_url.ends_with("/v1") {
            format!("{base_url}/models")
        } else {
            format!("{base_url}/v1/models")
        };

        let mut req = agent.get(&models_url);
        if let Some(ref key) = config.api_key {
            if !key.trim().is_empty() {
                req = req.set("Authorization", &format!("Bearer {}", key.trim()));
            }
        }

        let resp = match req.call() {
            Ok(r) => r,
            Err(ureq::Error::Status(code, resp)) => {
                let text = resp.into_string().unwrap_or_default();
                return Ok(AiStatus {
                    ok: false,
                    message: format!("AI server returned HTTP {code}: {text}"),
                    latency_ms: start.elapsed().as_millis() as u64,
                    models: Vec::new(),
                });
            }
            Err(e) => {
                return Ok(AiStatus {
                    ok: false,
                    message: format!("Could not connect to AI server at {base_url} ({e})"),
                    latency_ms: start.elapsed().as_millis() as u64,
                    models: Vec::new(),
                });
            }
        };

        #[derive(Deserialize)]
        struct OpenAiModel {
            id: String,
        }
        #[derive(Deserialize)]
        struct OpenAiModelsResponse {
            data: Option<Vec<OpenAiModel>>,
        }

        let models = match resp.into_json::<OpenAiModelsResponse>() {
            Ok(body) => body
                .data
                .unwrap_or_default()
                .into_iter()
                .map(|m| m.id)
                .collect::<Vec<_>>(),
            Err(_) => Vec::new(),
        };

        let latency = start.elapsed().as_millis() as u64;
        Ok(AiStatus {
            ok: true,
            message: format!("Connected successfully ({latency}ms)"),
            latency_ms: latency,
            models,
        })
    }
}

/// Executes a chat completion request against the configured provider.
pub fn generate_chat(
    app: &tauri::AppHandle,
    config: &AiConfig,
    system_prompt: &str,
    user_prompt: &str,
) -> AppResult<String> {
    let temperature = config.temperature.unwrap_or(0.2);

    if config.provider == "embedded" || config.provider == "local" {
        return super::embedded::generate(app, system_prompt, user_prompt, temperature);
    }

    let base_url = validate_endpoint(&config.endpoint)?;
    let agent = create_agent();

    if config.provider == "ollama" {
        let chat_url = format!("{base_url}/api/chat");
        let payload = serde_json::json!({
            "model": config.model.trim(),
            "messages": [
                { "role": "system", "content": system_prompt },
                { "role": "user", "content": user_prompt }
            ],
            "stream": false,
            "options": {
                "temperature": temperature
            }
        });

        let resp = agent
            .post(&chat_url)
            .send_json(payload)
            .map_err(|e| match e {
                ureq::Error::Status(code, r) => {
                    let text = r.into_string().unwrap_or_default();
                    AppError::Msg(format!("Ollama error (HTTP {code}): {text}"))
                }
                ureq::Error::Transport(t) => {
                    AppError::Msg(format!("Cannot connect to Ollama at {base_url}: {t}"))
                }
            })?;

        #[derive(Deserialize)]
        struct OllamaMessage {
            content: String,
        }
        #[derive(Deserialize)]
        struct OllamaChatResponse {
            message: OllamaMessage,
        }

        let body: OllamaChatResponse = resp
            .into_json()
            .map_err(|e| AppError::Msg(format!("Failed to parse Ollama response: {e}")))?;

        Ok(body.message.content)
    } else {
        let chat_url = if base_url.ends_with("/v1") {
            format!("{base_url}/chat/completions")
        } else {
            format!("{base_url}/v1/chat/completions")
        };

        let mut req = agent.post(&chat_url);
        if let Some(ref key) = config.api_key {
            if !key.trim().is_empty() {
                req = req.set("Authorization", &format!("Bearer {}", key.trim()));
            }
        }

        let payload = serde_json::json!({
            "model": config.model.trim(),
            "messages": [
                { "role": "system", "content": system_prompt },
                { "role": "user", "content": user_prompt }
            ],
            "temperature": temperature,
            "stream": false
        });

        let resp = req.send_json(payload).map_err(|e| match e {
            ureq::Error::Status(code, r) => {
                let text = r.into_string().unwrap_or_default();
                AppError::Msg(format!("AI API error (HTTP {code}): {text}"))
            }
            ureq::Error::Transport(t) => {
                AppError::Msg(format!("Cannot connect to AI endpoint at {base_url}: {t}"))
            }
        })?;

        #[derive(Deserialize)]
        struct ChoiceMessage {
            content: Option<String>,
        }
        #[derive(Deserialize)]
        struct Choice {
            message: ChoiceMessage,
        }
        #[derive(Deserialize)]
        struct ChatCompletionResponse {
            choices: Vec<Choice>,
        }

        let body: ChatCompletionResponse = resp
            .into_json()
            .map_err(|e| AppError::Msg(format!("Failed to parse AI response: {e}")))?;

        let content = body
            .choices
            .first()
            .and_then(|c| c.message.content.clone())
            .unwrap_or_default();

        Ok(content)
    }
}

/// Known conventional commit types.
const KNOWN_TYPES: &[&str] = &[
    "feat", "fix", "docs", "style", "refactor", "perf", "test", "build", "ci", "chore", "revert",
];

/// Cleans and extracts structured fields from an LLM-generated commit message.
pub fn parse_commit_message(raw: &str) -> GeneratedCommit {
    let mut cleaned = raw.trim();

    // Strip markdown code fences if model enclosed response in ```...```
    if cleaned.starts_with("```") {
        if let Some(end) = cleaned.rfind("```") {
            if end > 3 {
                cleaned = &cleaned[3..end];
                // strip optional language tag like ```markdown or ```text
                if let Some(nl) = cleaned.find('\n') {
                    let first = cleaned[..nl].trim();
                    if first.chars().all(|c| c.is_ascii_alphabetic()) {
                        cleaned = &cleaned[nl + 1..];
                    }
                }
            }
        }
    }

    let cleaned = cleaned.trim().trim_matches('"').trim_matches('\'').trim();

    // Split into first line and body
    let mut lines = cleaned.lines();
    let first_line = lines.next().unwrap_or_default().trim();
    let body_lines = lines.collect::<Vec<_>>().join("\n").trim().to_string();
    let body = if body_lines.is_empty() {
        None
    } else {
        Some(body_lines)
    };

    // Parse conventional commit format: type(scope)!: subject OR type: subject
    let mut commit_type = None;
    let mut scope = None;
    let mut subject = first_line.to_string();
    let mut breaking = false;

    if let Some(colon_pos) = first_line.find(':') {
        let prefix = first_line[..colon_pos].trim();
        let rest = first_line[colon_pos + 1..].trim();

        // Check if prefix ends with '!' for breaking change
        breaking = prefix.ends_with('!');
        let prefix_clean = prefix.strip_suffix('!').unwrap_or(prefix);

        if let Some(open_paren) = prefix_clean.find('(') {
            if let Some(close_paren) = prefix_clean.rfind(')') {
                if close_paren > open_paren {
                    let t = &prefix_clean[..open_paren].trim().to_lowercase();
                    let s = &prefix_clean[open_paren + 1..close_paren].trim().to_lowercase();

                    if KNOWN_TYPES.contains(&t.as_str()) {
                        commit_type = Some(t.to_string());
                        if !s.is_empty() {
                            scope = Some(s.to_string());
                        }
                        subject = rest.to_string();
                    }
                }
            }
        } else {
            let t = prefix_clean.to_lowercase();
            if KNOWN_TYPES.contains(&t.as_str()) {
                commit_type = Some(t);
                subject = rest.to_string();
            }
        }
    }

    GeneratedCommit {
        full_message: cleaned.to_string(),
        commit_type,
        scope,
        subject,
        body,
        breaking,
    }
}

/// Parses PR title and description from LLM output.
pub fn parse_pr_response(raw: &str) -> GeneratedPr {
    let cleaned = raw.trim();

    // Check for TITLE: and BODY: markers
    if let Some(title_pos) = cleaned.find("TITLE:") {
        let after_title = &cleaned[title_pos + 6..];
        if let Some(body_pos) = after_title.find("BODY:") {
            let title = after_title[..body_pos].trim();
            let body = after_title[body_pos + 5..].trim();
            return GeneratedPr {
                title: title.to_string(),
                body: body.to_string(),
            };
        }
    }

    // Fallback: first line is title, rest is body
    let mut lines = cleaned.lines();
    let title = lines
        .next()
        .unwrap_or("Update")
        .trim()
        .trim_start_matches('#')
        .trim()
        .to_string();
    let body = lines.collect::<Vec<_>>().join("\n").trim().to_string();

    GeneratedPr { title, body }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_commit_simple() {
        let msg = "feat: add oauth login support";
        let parsed = parse_commit_message(msg);
        assert_eq!(parsed.commit_type.as_deref(), Some("feat"));
        assert_eq!(parsed.scope, None);
        assert_eq!(parsed.subject, "add oauth login support");
        assert_eq!(parsed.body, None);
    }

    #[test]
    fn test_parse_commit_scoped_with_body() {
        let msg = "fix(auth): prevent token expiration race\n\n- refresh token before expiry\n- handle 401";
        let parsed = parse_commit_message(msg);
        assert_eq!(parsed.commit_type.as_deref(), Some("fix"));
        assert_eq!(parsed.scope.as_deref(), Some("auth"));
        assert_eq!(parsed.subject, "prevent token expiration race");
        assert_eq!(
            parsed.body.as_deref(),
            Some("- refresh token before expiry\n- handle 401")
        );
    }

    #[test]
    fn test_parse_commit_code_fenced() {
        let msg = "```markdown\nrefactor(graph): optimize lane layout\n\nreduce memory overhead\n```";
        let parsed = parse_commit_message(msg);
        assert_eq!(parsed.commit_type.as_deref(), Some("refactor"));
        assert_eq!(parsed.scope.as_deref(), Some("graph"));
        assert_eq!(parsed.subject, "optimize lane layout");
        assert_eq!(parsed.body.as_deref(), Some("reduce memory overhead"));
    }

    #[test]
    fn test_parse_commit_breaking() {
        let msg = "feat(api)!: drop legacy v1 endpoints\n\nBREAKING CHANGE: v1 routes are removed";
        let parsed = parse_commit_message(msg);
        assert_eq!(parsed.commit_type.as_deref(), Some("feat"));
        assert_eq!(parsed.scope.as_deref(), Some("api"));
        assert_eq!(parsed.subject, "drop legacy v1 endpoints");
        assert!(parsed.breaking);
        assert_eq!(
            parsed.body.as_deref(),
            Some("BREAKING CHANGE: v1 routes are removed")
        );
    }

    #[test]
    fn test_parse_pr_markers() {
        let raw = "TITLE: feat(api): add v2 endpoints\nBODY:\n## Summary\nAdds v2 endpoints.\n\n## Changes\n- new routes";
        let parsed = parse_pr_response(raw);
        assert_eq!(parsed.title, "feat(api): add v2 endpoints");
        assert_eq!(
            parsed.body,
            "## Summary\nAdds v2 endpoints.\n\n## Changes\n- new routes"
        );
    }
}

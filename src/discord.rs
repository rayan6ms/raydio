//! Discord response helpers. Twilight owns Bot authentication and rate limiting.
use crate::views::View;
use anyhow::Result;
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::time::timeout;
use twilight_http::Client;
use twilight_model::{
    application::interaction::{
        Interaction, InteractionData, application_command::CommandOptionValue,
    },
    channel::{
        Message,
        message::{AllowedMentions, MessageFlags},
    },
    http::interaction::{InteractionResponse, InteractionResponseData, InteractionResponseType},
};

#[derive(Clone)]
pub struct Request {
    pub interaction: Arc<Interaction>,
    pub name: String,
    pub options: HashMap<String, String>,
    pub custom_id: Option<String>,
}
impl Request {
    pub fn new(interaction: Arc<Interaction>) -> Self {
        let mut result = Self {
            interaction,
            name: String::new(),
            options: HashMap::new(),
            custom_id: None,
        };
        match result.interaction.data.as_ref() {
            Some(InteractionData::ApplicationCommand(data)) => {
                result.name = data.name.clone();
                for option in &data.options {
                    match &option.value {
                        CommandOptionValue::String(value)
                        | CommandOptionValue::Focused(value, _) => {
                            result.options.insert(option.name.clone(), value.clone());
                        }
                        CommandOptionValue::Integer(value) => {
                            result
                                .options
                                .insert(option.name.clone(), value.to_string());
                        }
                        _ => {}
                    }
                }
            }
            Some(InteractionData::MessageComponent(data)) => {
                result.custom_id = Some(data.custom_id.clone());
            }
            _ => {}
        }
        result
    }
    pub fn user(&self) -> u64 {
        self.interaction.author_id().map(|id| id.get()).unwrap_or(0)
    }
    pub fn channel(&self) -> Option<u64> {
        self.interaction.channel.as_ref().map(|c| c.id.get())
    }
    pub fn option(&self, name: &str) -> &str {
        self.options.get(name).map(String::as_str).unwrap_or("")
    }
    pub fn index(&self, name: &str) -> usize {
        self.option(name).parse().unwrap_or(0)
    }
    pub fn label(&self) -> String {
        self.interaction
            .member
            .as_ref()
            .and_then(|m| m.nick.clone())
            .or_else(|| {
                self.interaction
                    .author()
                    .map(|u| u.global_name.clone().unwrap_or_else(|| u.name.clone()))
            })
            .unwrap_or_else(|| "Listener".into())
    }
    pub fn updates_message(&self) -> bool {
        self.custom_id
            .as_ref()
            .is_some_and(|id| !(id.starts_with("raydio:player:") && id.ends_with(":queue")))
    }
    pub async fn acknowledge(&self, http: &Client) -> bool {
        self.acknowledge_with_deadline(http, Duration::from_secs(3))
            .await
    }
    async fn acknowledge_with_deadline(&self, http: &Client, deadline: Duration) -> bool {
        let response = InteractionResponse {
            kind: if self.updates_message() {
                InteractionResponseType::DeferredUpdateMessage
            } else {
                InteractionResponseType::DeferredChannelMessageWithSource
            },
            data: if self.name == "diagnostics"
                || (self.custom_id.is_some() && !self.updates_message())
            {
                Some(InteractionResponseData {
                    flags: Some(MessageFlags::EPHEMERAL),
                    ..Default::default()
                })
            } else {
                None
            },
        };
        let started = Instant::now();
        let result = timeout(
            deadline,
            http.interaction(self.interaction.application_id)
                .create_response(self.interaction.id, &self.interaction.token, &response),
        )
        .await;
        if matches!(result, Ok(Ok(_))) {
            tracing::info!(
                guild = self.interaction.guild_id.map(|id| id.get()),
                interaction = self.interaction.id.get(),
                elapsed_ms = started.elapsed().as_millis() as u64,
                "Interaction acknowledged"
            );
            return true;
        }
        // A lost/slow HTTP response does not imply Discord rejected the defer.
        // Verify the original response before dropping an accepted command.
        let ambiguous = match &result {
            Err(_) => true,
            Ok(Err(error)) => recoverable_ack_error(error),
            _ => false,
        };
        if ambiguous
            && matches!(
                timeout(Duration::from_secs(1), async {
                    http.interaction(self.interaction.application_id)
                        .response(&self.interaction.token)
                        .await?
                        .bytes()
                        .await
                        .map_err(anyhow::Error::from)
                })
                .await,
                Ok(Ok(_))
            )
        {
            tracing::warn!(
                guild = self.interaction.guild_id.map(|id| id.get()),
                interaction = self.interaction.id.get(),
                "Recovered accepted interaction after acknowledgement response failure"
            );
            return true;
        }
        match result {
            Ok(Err(error)) => self.log_error("acknowledge", &error.into()),
            Err(error) => self.log_error("acknowledge", &error.into()),
            _ => {}
        }
        false
    }
    /// Reject before deferring, so admission failures stay private and never edit a panel.
    pub async fn reject(&self, http: &Client, text: &str) {
        let autocomplete = self.interaction.kind
            == twilight_model::application::interaction::InteractionType::ApplicationCommandAutocomplete;
        let response = InteractionResponse {
            kind: if autocomplete {
                InteractionResponseType::ApplicationCommandAutocompleteResult
            } else {
                InteractionResponseType::ChannelMessageWithSource
            },
            data: Some(if autocomplete {
                InteractionResponseData {
                    choices: Some(vec![]),
                    ..Default::default()
                }
            } else {
                InteractionResponseData {
                    content: Some(text.to_owned()),
                    flags: Some(MessageFlags::EPHEMERAL),
                    allowed_mentions: Some(no_mentions()),
                    ..Default::default()
                }
            }),
        };
        let _ = timeout(
            Duration::from_secs(2),
            http.interaction(self.interaction.application_id)
                .create_response(self.interaction.id, &self.interaction.token, &response),
        )
        .await;
    }
    pub async fn respond(&self, http: &Client, view: View) -> Result<Message> {
        self.respond_with_deadline(http, view, Duration::from_secs(8))
            .await
    }
    async fn respond_with_deadline(
        &self,
        http: &Client,
        view: View,
        deadline: Duration,
    ) -> Result<Message> {
        let result = timeout(deadline, async {
            http.interaction(self.interaction.application_id)
                .update_response(&self.interaction.token)
                .content(view.content.as_deref())
                .embeds(Some(&view.embeds))
                .components(Some(&view.components))
                .await?
                .model()
                .await
                .map_err(anyhow::Error::from)
        })
        .await
        .map_err(anyhow::Error::from)
        .and_then(|result| result);
        if let Err(error) = &result {
            self.log_error("respond", error);
        } else {
            tracing::info!(
                guild = self.interaction.guild_id.map(|id| id.get()),
                interaction = self.interaction.id.get(),
                "Interaction response completed"
            );
        }
        result
    }
    fn log_error(&self, operation: &'static str, error: &anyhow::Error) {
        // Never format HTTP errors: their bodies/URLs may contain credentials.
        let (kind, status, code) = error
            .downcast_ref::<twilight_http::Error>()
            .map(http_error_summary)
            .unwrap_or((
                if error.is::<tokio::time::error::Elapsed>() {
                    "timeout"
                } else {
                    "decode"
                },
                None,
                None,
            ));
        tracing::warn!(
            guild = self.interaction.guild_id.map(|id| id.get()),
            interaction = self.interaction.id.get(),
            operation,
            kind,
            status,
            code,
            "Discord interaction response failed"
        );
    }
    /// Edit a deferred player component through the same channel route as its
    /// periodic refresh. Mixing webhook and channel edits allowed Discord to
    /// persist an older progress snapshot after a newer control snapshot.
    /// Drain the response before the next edit without decoding a Message.
    pub async fn respond_no_model(&self, http: &Client, view: &View) -> Result<()> {
        let message = self
            .interaction
            .message
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("Player component has no message"))?;
        timeout(Duration::from_secs(8), async {
            http.update_message(message.channel_id, message.id)
                .content(view.content.as_deref())
                .embeds(Some(&view.embeds))
                .components(Some(&view.components))
                .await?
                .bytes()
                .await?;
            Ok::<(), anyhow::Error>(())
        })
        .await??;
        Ok(())
    }
    pub async fn error(&self, http: &Client, text: &str) {
        if self.updates_message() {
            let _ = timeout(
                Duration::from_secs(5),
                http.interaction(self.interaction.application_id)
                    .create_followup(&self.interaction.token)
                    .content(text)
                    .flags(MessageFlags::EPHEMERAL),
            )
            .await;
        } else {
            if let Err(error) = self.respond(http, View::text(text)).await
                && transient_response_error(&error)
            {
                // Editing the original is idempotent; one bounded retry also
                // clears a defer whose successful HTTP response was lost.
                let _ = self.respond(http, View::text(text)).await;
            }
        }
    }
}
fn http_error_summary(error: &twilight_http::Error) -> (&'static str, Option<u16>, Option<u64>) {
    use twilight_http::{api_error::ApiError, error::ErrorType};
    match error.kind() {
        ErrorType::Response { status, error, .. } => (
            "http",
            Some(status.get()),
            match error {
                ApiError::General(error) => Some(error.code),
                _ => None,
            },
        ),
        ErrorType::Parsing { .. } => ("decode", None, None),
        ErrorType::Validation => ("validation", None, None),
        ErrorType::Unauthorized => ("unauthorized", None, None),
        _ => ("transport", None, None),
    }
}
fn recoverable_ack_error(error: &twilight_http::Error) -> bool {
    let (kind, status, code) = http_error_summary(error);
    kind == "transport" || status.is_some_and(|s| s >= 500) || code == Some(40060)
}
fn transient_response_error(error: &anyhow::Error) -> bool {
    error.is::<tokio::time::error::Elapsed>()
        || error
            .downcast_ref::<twilight_http::Error>()
            .is_some_and(|error| {
                let (kind, status, _) = http_error_summary(error);
                kind == "transport" || status.is_some_and(|s| s >= 500)
            })
}
pub fn no_mentions() -> AllowedMentions {
    AllowedMentions {
        parse: vec![],
        replied_user: false,
        roles: vec![],
        users: vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        Router,
        http::{Method, StatusCode},
    };
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn request() -> Request {
        Request::new(Arc::new(serde_json::from_value(json!({
            "id":"100","application_id":"9","type":2,"token":"fixture-only","version":1,
            "guild_id":"1","channel":{"id":"10","type":0},"authorizing_integration_owners":{},"entitlements":[],
            "member":{"flags":0,"deaf":false,"mute":false,"roles":[],"user":{"id":"2","username":"listener","discriminator":"0001"}},
            "data":{"id":"30","name":"play","type":1,"options":[]}
        })).unwrap()))
    }
    async fn fixture(router: Router) -> (Client, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        (
            Client::builder()
                .token("fixture".into())
                .proxy(address.to_string(), true)
                .ratelimiter(None)
                .build(),
            server,
        )
    }
    #[tokio::test]
    async fn acknowledgement_checks_acceptance_when_http_response_is_lost() {
        for accepted in [true, false] {
            let calls = Arc::new(AtomicUsize::new(0));
            let observed = calls.clone();
            let router = Router::new().fallback(move |method: Method| {
                let calls = observed.clone();
                async move {
                    calls.fetch_add(1, Ordering::Relaxed);
                    if method == Method::POST {
                        // Discord created the defer, but its HTTP reply is slow.
                        tokio::time::sleep(Duration::from_millis(100)).await;
                        (StatusCode::NO_CONTENT, axum::Json(json!(null)))
                    } else if accepted {
                        (StatusCode::OK, axum::Json(json!({"flags":128})))
                    } else {
                        (
                            StatusCode::NOT_FOUND,
                            axum::Json(json!({"code":10015,"message":"Unknown Webhook"})),
                        )
                    }
                }
            });
            let (http, server) = fixture(router).await;
            assert_eq!(
                request()
                    .acknowledge_with_deadline(&http, Duration::from_millis(50))
                    .await,
                accepted
            );
            assert_eq!(calls.load(Ordering::Relaxed), 2);
            server.abort();
            let _ = server.await;
        }
    }
    #[tokio::test]
    async fn terminal_acknowledgement_errors_do_not_execute_a_command() {
        let calls = Arc::new(AtomicUsize::new(0));
        let observed = calls.clone();
        let router = Router::new().fallback(move || {
            observed.fetch_add(1, Ordering::Relaxed);
            async {
                (
                    StatusCode::NOT_FOUND,
                    axum::Json(json!({"code":10062,"message":"Unknown interaction"})),
                )
            }
        });
        let (http, server) = fixture(router).await;
        assert!(!request().acknowledge(&http).await);
        assert_eq!(calls.load(Ordering::Relaxed), 1);
        server.abort();
        let _ = server.await;
    }
    #[tokio::test]
    async fn response_body_is_included_in_the_completion_deadline() {
        let router = Router::new().fallback(|| async {
            let chunks = futures_util::stream::once(async { Ok::<_, std::io::Error>("{") });
            let stalled = futures_util::stream::pending::<Result<&str, std::io::Error>>();
            use futures_util::StreamExt;
            axum::body::Body::from_stream(chunks.chain(stalled))
        });
        let (http, server) = fixture(router).await;
        let result = request()
            .respond_with_deadline(&http, View::text("fixture"), Duration::from_millis(50))
            .await;
        assert!(result.unwrap_err().is::<tokio::time::error::Elapsed>());
        server.abort();
        let _ = server.await;
    }
}

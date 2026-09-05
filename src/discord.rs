//! Discord response helpers. Twilight owns Bot authentication and rate limiting.
use crate::views::View;
use anyhow::Result;
use std::{collections::HashMap, sync::Arc, time::Duration};
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
        matches!(
            timeout(
                Duration::from_secs(3),
                http.interaction(self.interaction.application_id)
                    .create_response(self.interaction.id, &self.interaction.token, &response)
            )
            .await,
            Ok(Ok(_))
        )
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
        let response = timeout(
            Duration::from_secs(8),
            http.interaction(self.interaction.application_id)
                .update_response(&self.interaction.token)
                .content(view.content.as_deref())
                .embeds(Some(&view.embeds))
                .components(Some(&view.components)),
        )
        .await??;
        Ok(response.model().await?)
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
            let _ = self.respond(http, View::text(text)).await;
        }
    }
}
pub fn no_mentions() -> AllowedMentions {
    AllowedMentions {
        parse: vec![],
        replied_user: false,
        roles: vec![],
        users: vec![],
    }
}

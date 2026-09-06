use twilight_model::application::command::{Command, CommandOption};

pub const HELP: &str = include_str!("../assets/help.txt");
pub fn definitions() -> Vec<Command> {
    let mut commands: serde_json::Value =
        serde_json::from_str(include_str!("../assets/commands.json"))
            .expect("checked command JSON");
    for command in commands.as_array_mut().expect("command array") {
        command["version"] = serde_json::json!("1");
    }
    serde_json::from_value(commands).expect("checked command schema")
}

/// Discord assigns IDs/versions and fills default flags. Compare the command
/// behavior so ordinary restarts do not rewrite an unchanged global manifest.
pub fn matches_registered(current: &[Command], wanted: &[Command]) -> bool {
    current.len() == wanted.len()
        && wanted.iter().all(|wanted| {
            current.iter().any(|current| {
                current.name == wanted.name
                    && current.kind == wanted.kind
                    && current.guild_id == wanted.guild_id
                    && current.contexts == wanted.contexts
                    && current.integration_types == wanted.integration_types
                    && current.default_member_permissions == wanted.default_member_permissions
                    && current.description == wanted.description
                    && current.description_localizations == wanted.description_localizations
                    && current.name_localizations == wanted.name_localizations
                    && current.nsfw.unwrap_or(false) == wanted.nsfw.unwrap_or(false)
                    && normalized_options(&current.options) == normalized_options(&wanted.options)
            })
        })
}

fn normalized_options(options: &[CommandOption]) -> Vec<CommandOption> {
    options
        .iter()
        .cloned()
        .map(|mut option| {
            option.required = Some(option.required.unwrap_or(false));
            option.autocomplete = Some(option.autocomplete.unwrap_or(false));
            if let Some(nested) = &mut option.options {
                *nested = normalized_options(nested);
            }
            option
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn observed_discord_response_defaults_match_the_manifest() {
        let registered: Vec<Command> =
            serde_json::from_str(include_str!("../tests/fixtures/discord-commands.json")).unwrap();
        assert!(matches_registered(&registered, &definitions()));
    }
    #[test]
    fn assigned_metadata_and_order_do_not_require_a_command_rewrite() {
        let wanted = definitions();
        let mut registered = wanted.clone();
        for command in &mut registered {
            command.id = Some(twilight_model::id::Id::new(42));
            command.application_id = Some(twilight_model::id::Id::new(7));
            command.version = twilight_model::id::Id::new(99);
            command.nsfw = Some(false);
        }
        registered.reverse();
        assert!(matches_registered(&registered, &wanted));
        registered[0].description.push_str(" changed");
        assert!(!matches_registered(&registered, &wanted));
        assert!(!matches_registered(&wanted[1..], &wanted));
        let mut changed = wanted.clone();
        changed[0].options[0].autocomplete = Some(false);
        assert!(!matches_registered(&changed, &wanted));
        changed = wanted.clone();
        changed[0].default_member_permissions =
            Some(twilight_model::guild::Permissions::ADMINISTRATOR);
        assert!(!matches_registered(&changed, &wanted));
    }
    #[test]
    fn all_nineteen_commands_keep_the_original_options_and_scope() {
        let commands = definitions();
        assert_eq!(commands.len(), 19);
        let play = commands.iter().find(|c| c.name == "play").unwrap();
        assert_eq!(play.options.len(), 1);
        assert_eq!(play.options[0].autocomplete, Some(true));
        assert_eq!(play.options[0].required, Some(true));
        let diagnostics = commands.iter().find(|c| c.name == "diagnostics").unwrap();
        assert_eq!(diagnostics.default_member_permissions.unwrap().bits(), 32);
    }
}

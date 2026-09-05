use twilight_model::application::command::Command;

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

#[cfg(test)]
mod tests {
    use super::*;
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

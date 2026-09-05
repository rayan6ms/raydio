//! The small subset of Discord guild state needed for voice access and handshakes.
use std::collections::HashMap;
use twilight_model::{
    channel::{
        Channel, ChannelType,
        permission_overwrite::{PermissionOverwrite, PermissionOverwriteType},
    },
    gateway::{event::Event, payload::incoming::GuildCreate},
    guild::{Member, Permissions},
    voice::VoiceState,
};

pub const MAX_GUILDS: usize = 1000;
const MAX_VOICE_MEMBERS: usize = 10_000;

#[derive(Default)]
pub struct Cache {
    pub guilds: HashMap<u64, Guild>,
    pub ready: bool,
}
#[derive(Default)]
pub struct Guild {
    pub available: bool,
    pub owner: u64,
    pub channels: HashMap<u64, ChannelAccess>,
    pub roles: HashMap<u64, Permissions>,
    pub bot_roles: Option<Vec<u64>>,
    pub voices: HashMap<u64, Voice>,
    pub server: Option<Server>,
    pub activity: Activity,
}
#[derive(Clone, Default)]
pub struct Activity {
    pub channel: Option<u64>,
    pub queue_count: usize,
    pub pending: usize,
    pub title: Option<String>,
}
#[derive(Clone)]
pub struct Voice {
    pub channel: u64,
    pub bot: bool,
    pub session: String,
}
#[derive(Clone, PartialEq)]
pub struct Server {
    pub token: String,
    pub endpoint: String,
}

/// Only the channel facts used by voice admission. Names, topics, messages,
/// thread/forum metadata and other Discord payload fields are not retained.
pub struct ChannelAccess {
    pub kind: ChannelType,
    pub user_limit: Option<u32>,
    pub permission_overwrites: Box<[PermissionOverwrite]>,
}
impl From<&Channel> for ChannelAccess {
    fn from(channel: &Channel) -> Self {
        Self {
            kind: channel.kind,
            user_limit: channel.user_limit,
            permission_overwrites: channel
                .permission_overwrites
                .as_deref()
                .unwrap_or_default()
                .into(),
        }
    }
}

impl Cache {
    /// Return the guild whose voice/session facts changed, if any.
    pub fn update(&mut self, event: &Event, bot: u64) -> Option<u64> {
        match event {
            Event::Ready(_) | Event::Resumed => self.ready = true,
            Event::GatewayClose(_) => self.ready = false,
            Event::GuildCreate(create) => match create.as_ref() {
                GuildCreate::Available(g) => {
                    let id = g.id.get();
                    if self.guilds.len() >= MAX_GUILDS && !self.guilds.contains_key(&id) {
                        return None;
                    }
                    let mut guild = Guild {
                        available: true,
                        owner: g.owner_id.get(),
                        channels: g.channels.iter().map(|c| (c.id.get(), c.into())).collect(),
                        roles: g
                            .roles
                            .iter()
                            .map(|r| (r.id.get(), r.permissions))
                            .collect(),
                        bot_roles: g
                            .members
                            .iter()
                            .find(|m| m.user.id.get() == bot)
                            .map(|m| m.roles.iter().map(|r| r.get()).collect()),
                        ..Guild::default()
                    };
                    for v in &g.voice_states {
                        guild.voice(v, bot);
                    }
                    self.guilds.insert(id, guild);
                    return Some(id);
                }
                GuildCreate::Unavailable(g) => {
                    if let Some(guild) = self.guilds.get_mut(&g.id.get()) {
                        guild.available = false;
                    }
                }
            },
            Event::GuildDelete(g) => {
                if g.unavailable.unwrap_or(false) {
                    if let Some(guild) = self.guilds.get_mut(&g.id.get()) {
                        guild.available = false;
                    }
                } else {
                    self.guilds.remove(&g.id.get());
                }
                return Some(g.id.get());
            }
            Event::GuildUpdate(g) => {
                if let Some(guild) = self.guilds.get_mut(&g.id.get()) {
                    guild.owner = g.owner_id.get();
                }
            }
            Event::ChannelCreate(c) => {
                if let Some(guild) = c.guild_id.and_then(|id| self.guilds.get_mut(&id.get())) {
                    guild.channels.insert(c.id.get(), (&c.0).into());
                }
            }
            Event::ChannelUpdate(c) => {
                if let Some(guild) = c.guild_id.and_then(|id| self.guilds.get_mut(&id.get())) {
                    guild.channels.insert(c.id.get(), (&c.0).into());
                }
            }
            Event::ChannelDelete(c) => {
                if let Some(guild) = c.guild_id.and_then(|id| self.guilds.get_mut(&id.get())) {
                    guild.channels.remove(&c.id.get());
                }
            }
            Event::RoleCreate(r) => {
                if let Some(guild) = self.guilds.get_mut(&r.guild_id.get()) {
                    guild.roles.insert(r.role.id.get(), r.role.permissions);
                }
            }
            Event::RoleUpdate(r) => {
                if let Some(guild) = self.guilds.get_mut(&r.guild_id.get()) {
                    guild.roles.insert(r.role.id.get(), r.role.permissions);
                }
            }
            Event::RoleDelete(r) => {
                if let Some(guild) = self.guilds.get_mut(&r.guild_id.get()) {
                    guild.roles.remove(&r.role_id.get());
                }
            }
            Event::MemberUpdate(m) if m.user.id.get() == bot => {
                if let Some(guild) = self.guilds.get_mut(&m.guild_id.get()) {
                    guild.bot_roles = Some(m.roles.iter().map(|r| r.get()).collect());
                }
            }
            Event::VoiceStateUpdate(v) => {
                if let Some(id) = v.guild_id {
                    if let Some(guild) = self.guilds.get_mut(&id.get()) {
                        guild.voice(v, bot);
                    }
                    return Some(id.get());
                }
            }
            Event::VoiceServerUpdate(v) => {
                if let Some(guild) = self.guilds.get_mut(&v.guild_id.get()) {
                    guild.server = v.endpoint.as_ref().map(|endpoint| Server {
                        endpoint: endpoint.clone(),
                        token: v.token.clone(),
                    });
                }
                return Some(v.guild_id.get());
            }
            _ => {}
        }
        None
    }
}
impl Guild {
    fn voice(&mut self, v: &VoiceState, bot: u64) {
        if v.user_id.get() == bot
            && let Some(member) = &v.member
        {
            self.member(member);
        }
        if let Some(channel) = v.channel_id {
            if self.voices.len() < MAX_VOICE_MEMBERS || self.voices.contains_key(&v.user_id.get()) {
                self.voices.insert(
                    v.user_id.get(),
                    Voice {
                        channel: channel.get(),
                        bot: v.member.as_ref().map(|m| m.user.bot).unwrap_or_else(|| {
                            self.voices.get(&v.user_id.get()).is_some_and(|v| v.bot)
                        }) || v.user_id.get() == bot,
                        session: if v.user_id.get() == bot {
                            v.session_id.clone()
                        } else {
                            String::new()
                        },
                    },
                );
            }
        } else {
            self.voices.remove(&v.user_id.get());
            if v.user_id.get() == bot {
                self.server = None;
            }
        }
    }
    pub fn member(&mut self, m: &Member) {
        self.bot_roles = Some(m.roles.iter().map(|r| r.get()).collect());
    }
    pub fn alone(&self, channel: u64) -> bool {
        !self.voices.values().any(|v| v.channel == channel && !v.bot)
    }
    pub fn caller_channel(&self, caller: u64) -> Result<u64, String> {
        let channel = self
            .voices
            .get(&caller)
            .map(|v| v.channel)
            .ok_or("Join a voice channel first.")?;
        if self
            .channels
            .get(&channel)
            .is_none_or(|c| c.kind != ChannelType::GuildVoice)
        {
            return Err("Stage channels are not supported. Join a normal voice channel.".into());
        }
        Ok(channel)
    }
    pub fn access(
        &self,
        guild: u64,
        caller: u64,
        bot: u64,
        intended: Option<u64>,
    ) -> Result<u64, String> {
        let channel = self.caller_channel(caller).map_err(|error| {
            if intended.is_some() {
                "Your voice channel changed before the song could be queued.".into()
            } else if !self.voices.contains_key(&caller) {
                "Join a voice channel before using `/play`.".into()
            } else {
                error
            }
        })?;
        if intended.is_some_and(|id| id != channel) {
            return Err("Your voice channel changed before the song could be queued.".into());
        }
        let roles = self.bot_roles.as_ref().ok_or(
            "Discord has not finished loading the bot's server membership. Try again shortly.",
        )?;
        let channel_data = &self.channels[&channel];
        let permissions = permissions(guild, bot, self.owner, roles, &self.roles, channel_data);
        let missing: Vec<_> = [
            (Permissions::VIEW_CHANNEL, "View Channel"),
            (Permissions::CONNECT, "Connect"),
            (Permissions::SPEAK, "Speak"),
        ]
        .into_iter()
        .filter_map(|(permission, name)| (!permissions.contains(permission)).then_some(name))
        .collect();
        if !missing.is_empty() {
            return Err(format!(
                "I need these permissions in your voice channel: {}.",
                missing.join(", ")
            ));
        }
        let limit = channel_data.user_limit.unwrap_or(0) as usize;
        if limit > 0
            && self
                .voices
                .values()
                .filter(|v| v.channel == channel)
                .count()
                >= limit
            && self.voices.get(&bot).is_none_or(|v| v.channel != channel)
        {
            return Err("That voice channel is full, so I cannot join it.".into());
        }
        Ok(channel)
    }
}

pub fn permissions(
    guild: u64,
    user: u64,
    owner: u64,
    member_roles: &[u64],
    roles: &HashMap<u64, Permissions>,
    channel: &ChannelAccess,
) -> Permissions {
    let mut value = roles
        .get(&guild)
        .copied()
        .unwrap_or_else(Permissions::empty);
    for role in member_roles {
        value |= roles.get(role).copied().unwrap_or_else(Permissions::empty);
    }
    if user == owner || value.contains(Permissions::ADMINISTRATOR) {
        return Permissions::all();
    }
    let overwrites = &channel.permission_overwrites;
    if let Some(overwrite) = overwrites
        .iter()
        .find(|o| o.kind == PermissionOverwriteType::Role && o.id.get() == guild)
    {
        value = (value & !overwrite.deny) | overwrite.allow;
    }
    let mut deny = Permissions::empty();
    let mut allow = Permissions::empty();
    for overwrite in overwrites
        .iter()
        .filter(|o| o.kind == PermissionOverwriteType::Role && member_roles.contains(&o.id.get()))
    {
        deny |= overwrite.deny;
        allow |= overwrite.allow;
    }
    value = (value & !deny) | allow;
    if let Some(overwrite) = overwrites
        .iter()
        .find(|o| o.kind == PermissionOverwriteType::Member && o.id.get() == user)
    {
        value = (value & !overwrite.deny) | overwrite.allow;
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn compact_channels_follow_permission_updates_limits_and_deletes() {
        use twilight_model::gateway::payload::incoming::{
            ChannelCreate, ChannelDelete, ChannelUpdate,
        };
        let mut cache = Cache::default();
        let p = Permissions::VIEW_CHANNEL | Permissions::CONNECT | Permissions::SPEAK;
        cache.guilds.insert(
            1,
            Guild {
                roles: HashMap::from([(1, p)]),
                bot_roles: Some(vec![]),
                voices: HashMap::from([(
                    2,
                    Voice {
                        channel: 3,
                        bot: false,
                        session: String::new(),
                    },
                )]),
                ..Guild::default()
            },
        );
        let mut channel: Channel =
            serde_json::from_value(json!({"id":"3","guild_id":"1","type":2,"user_limit":2}))
                .unwrap();
        cache.update(
            &Event::ChannelCreate(Box::new(ChannelCreate(channel.clone()))),
            9,
        );
        assert_eq!(cache.guilds[&1].access(1, 2, 9, None), Ok(3));
        channel.user_limit = Some(1);
        cache.update(
            &Event::ChannelUpdate(Box::new(ChannelUpdate(channel.clone()))),
            9,
        );
        assert!(
            cache.guilds[&1]
                .access(1, 2, 9, None)
                .unwrap_err()
                .contains("full")
        );
        channel.user_limit = Some(2);
        channel.permission_overwrites = Some(serde_json::from_value(json!([{"id":"1","type":0,"allow":"0","deny":Permissions::CONNECT.bits().to_string()}])).unwrap());
        cache.update(
            &Event::ChannelUpdate(Box::new(ChannelUpdate(channel.clone()))),
            9,
        );
        assert!(
            cache.guilds[&1]
                .access(1, 2, 9, None)
                .unwrap_err()
                .contains("Connect")
        );
        channel.kind = ChannelType::GuildStageVoice;
        cache.update(
            &Event::ChannelUpdate(Box::new(ChannelUpdate(channel.clone()))),
            9,
        );
        assert!(
            cache.guilds[&1]
                .caller_channel(2)
                .unwrap_err()
                .contains("Stage")
        );
        cache.update(&Event::ChannelDelete(Box::new(ChannelDelete(channel))), 9);
        assert!(cache.guilds[&1].channels.is_empty());
    }
    #[test]
    fn private_voice_uses_role_aggregation_then_member_overwrites() {
        let p = Permissions::VIEW_CHANNEL | Permissions::CONNECT | Permissions::SPEAK;
        let roles = HashMap::from([(1, p), (2, Permissions::empty()), (3, Permissions::empty())]);
        let channel: Channel =
            serde_json::from_value(json!({"id":"5","type":2,"permission_overwrites":[
                {"id":"1","type":0,"allow":"0","deny":p.bits().to_string()},
                {"id":"2","type":0,"allow":p.bits().to_string(),"deny":"0"},
                {"id":"3","type":0,"allow":"0","deny":p.bits().to_string()},
                {"id":"9","type":1,"allow":"0","deny":Permissions::SPEAK.bits().to_string()}
            ]}))
            .unwrap();
        let channel = ChannelAccess::from(&channel);
        assert_eq!(
            permissions(1, 8, 99, &[], &roles, &channel),
            Permissions::empty()
        );
        assert!(permissions(1, 8, 99, &[2, 3], &roles, &channel).contains(p));
        assert!(!permissions(1, 9, 99, &[2], &roles, &channel).contains(Permissions::SPEAK));
        assert!(permissions(1, 99, 99, &[], &roles, &channel).contains(p));
    }
}

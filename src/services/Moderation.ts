import { Embed, Guild, Member, Message, TextChannel, User } from 'eris';
import moment from 'moment';

import { IMClient } from '../client';
import {
	punishmentConfigs,
	punishments,
	PunishmentType,
	sequelize,
	SettingsObject,
	strikes,
	ViolationType
} from '../sequelize';
import { to } from '../util';

interface Arguments {
	settings: SettingsObject;
	guild: Guild;
}

interface PunishmentDetails {
	reason?: string;
	strikeAmount?: number;
}

interface MiniMessage {
	createdAt: number;
	content: string;
	mentions: number;
	roleMentions: number;
}

export class Moderation {
	private client: IMClient;
	private messageCache: Map<string, MiniMessage[]>;

	private strikeConfigFunctions: {
		[key in ViolationType]: (
			message: Message,
			args: Arguments
		) => Promise<boolean>
	};
	private punishmentFunctions: {
		[key in PunishmentType]: (
			message: Message,
			guild: Guild,
			amount: number,
			args: Arguments
		) => Promise<boolean>
	};

	public constructor(client: IMClient) {
		this.client = client;

		this.messageCache = new Map();

		this.strikeConfigFunctions = {
			[ViolationType.invites]: this.invites.bind(this),
			[ViolationType.links]: this.links.bind(this),
			[ViolationType.words]: this.words.bind(this),
			[ViolationType.allCaps]: this.allCaps.bind(this),
			[ViolationType.duplicateText]: this.duplicateText.bind(this),
			[ViolationType.quickMessages]: this.quickMessages.bind(this),
			[ViolationType.mentionUsers]: this.mentionUsers.bind(this),
			[ViolationType.mentionRoles]: this.mentionRoles.bind(this),
			[ViolationType.emojis]: this.emojis.bind(this)
		};

		this.punishmentFunctions = {
			[PunishmentType.ban]: this.ban.bind(this),
			[PunishmentType.kick]: this.kick.bind(this),
			[PunishmentType.softban]: this.softban.bind(this),
			[PunishmentType.warn]: this.warn.bind(this),
			[PunishmentType.mute]: this.mute.bind(this)
		};

		const func = () => {
			const now = moment();
			this.messageCache.forEach((value, key) => {
				this.messageCache.set(
					key,
					value.filter(m => now.diff(m.createdAt, 'second') < 60)
				);
			});
		};
		setInterval(func, 60 * 1000);

		client.on('messageCreate', this.onMessage.bind(this));
	}

	private async onMessage(message: Message) {
		// Ignore bots
		if (message.author.bot) {
			return;
		}
		const channel = message.channel as TextChannel;
		const guild = channel.guild;

		// Ignore DMs
		if (!guild) {
			return;
		}

		// TODO Enable for all guilds when ready
		if (this.client.config.ownerGuildIds.indexOf(guild.id) === -1) {
			return;
		}

		const settings = await this.client.cache.settings.get(guild.id);

		if (!settings.autoModEnabled) {
			return;
		}

		let member = guild.members.get(message.author.id);
		if (!member) {
			member = await guild.getRESTMember(message.author.id);
		}

		/*
		if (member.permission.has(Permissions.ADMINISTRATOR)) {
			return;
		}
*/
		if (
			settings.autoModModeratedRoles &&
			settings.autoModModeratedRoles.length > 0
		) {
			if (
				!settings.autoModModeratedRoles.some(r => member.roles.indexOf(r) >= 0)
			) {
				return;
			}
		}

		if (
			settings.autoModModeratedChannels &&
			settings.autoModModeratedChannels.length > 0
		) {
			if (
				!(settings.autoModModeratedChannels.indexOf(message.channel.id) >= 0)
			) {
				return;
			}
		}

		if (
			settings.autoModIgnoredChannels &&
			settings.autoModIgnoredChannels.indexOf(message.channel.id) >= 0
		) {
			return;
		}

		if (
			settings.autoModIgnoredRoles &&
			settings.autoModIgnoredRoles.some(ir => member.roles.indexOf(ir) >= 0)
		) {
			return;
		}

		if (settings.autoModDisabledForOldMembers) {
			// Check if member is "oldMember"
			let memberAge = moment().diff(member.joinedAt, 'second');
			if (memberAge > settings.autoModDisabledForOldMembersThreshold) {
				// This is an old member
				return;
			}
		}

		const cacheKey = `${guild.id}-${message.author.id}`;
		let msgs = this.messageCache.get(cacheKey);
		if (msgs) {
			msgs.push(this.getMiniMessage(message));
			this.messageCache.set(cacheKey, msgs);
		} else {
			this.messageCache.set(cacheKey, [this.getMiniMessage(message)]);
		}

		let strikesCache = await this.client.cache.strikes.get(guild.id);
		let allViolations: ViolationType[] = Object.values(ViolationType);

		for (let strike of strikesCache) {
			allViolations = allViolations.filter(av => av !== strike.violationType);
			let foundViolation = await this.strikeConfigFunctions[
				strike.violationType
			](message, {
				settings: settings,
				guild: guild
			});
			if (!foundViolation) {
				continue;
			}
			message.delete();

			this.logViolationModAction(
				guild,
				channel,
				message,
				strike.violationType,
				strike.amount
			);

			const embed = this.createPunishmentEmbed('AutoModerator');
			embed.description = `Message by <@${
				message.author.id
			}> was removed because it violated the \`${
				strike.violationType
			}\` rule.\n`;
			embed.description += `\n\nUser got ${strike.amount} strikes.`;

			this.sendAndDelete(message, embed, settings);
			this.addStrikesAndCheckIfPunishable(
				message,
				strike.amount,
				strike.violationType,
				{ settings: settings, guild: guild }
			);
			return;
		}

		for (let violation of allViolations) {
			let foundViolation = await this.strikeConfigFunctions[violation](
				message,
				{
					settings: settings,
					guild: guild
				}
			);
			if (!foundViolation) {
				continue;
			}
			message.delete();

			this.logViolationModAction(guild, channel, message, violation);

			const embed = this.createPunishmentEmbed('AutoModerator');
			embed.description = `Message by <@${
				message.author.id
			}> was removed because it violated the \`${violation}\` rule.\n`;
			this.sendAndDelete(message, embed, settings);
			return;
		}
	}

	private logViolationModAction(
		guild: Guild,
		channel: TextChannel,
		message: Message,
		violationType: ViolationType,
		amount?: number
	) {
		const logEmbed = this.createPunishmentEmbed('AutoModerator');
		logEmbed.description = `**Channel** <#${channel.id}>\n`;
		logEmbed.description += `**User**: ${message.author.username}#${
			message.author.discriminator
		} (ID: ${message.author.id})\n`;
		logEmbed.description += `**Violation**: ${violationType}\n`;
		if (amount) {
			logEmbed.description += `**Strikes given**: ${amount}\n`;
		} else {
			logEmbed.description += `No strikes given.\n`;
		}
		logEmbed.fields.push({
			name: 'Message content',
			value: message.content
		});
		this.client.logModAction(guild, logEmbed);
	}

	private logPunishmentModAction(
		guild: Guild,
		user: User,
		amount: number,
		punishmentType: PunishmentType
	) {
		const logEmbed = this.client.createEmbed({
			author: { name: 'AutoModerator' },
			color: 16711680 // red
		});
		logEmbed.description = `**User**: ${user.username}#${
			user.discriminator
		} (ID: ${user.id})\n`;
		logEmbed.description += `**Strikes**: ${amount}\n`;
		logEmbed.description += `**Punishment**: ${punishmentType}\n`;
		this.client.logModAction(guild, logEmbed);
	}

	private getMiniMessage(message: Message): MiniMessage {
		return {
			createdAt: message.createdAt,
			content: message.content,
			mentions: message.mentions.length,
			roleMentions: message.roleMentions.length
		};
	}

	private async addStrikesAndCheckIfPunishable(
		message: Message,
		amount: number,
		violationType: ViolationType,
		args: Arguments
	) {
		let strikesBefore = await strikes.sum('amount', {
			where: {
				guildId: args.guild.id,
				memberId: message.author.id
			}
		});

		await strikes.create({
			id: null,
			guildId: args.guild.id,
			memberId: message.author.id,
			amount: amount,
			violationType: violationType
		});

		let strikesAfter = strikesBefore + amount;

		let punishmentConfig = await punishmentConfigs.find({
			where: {
				guildId: args.guild.id,
				amount: {
					[sequelize.Op.gt]: strikesBefore,
					[sequelize.Op.lte]: strikesAfter
				}
			},
			order: [['amount', 'DESC']]
		});

		if (punishmentConfig) {
			let punishmentResult = await this.punishmentFunctions[
				punishmentConfig.punishmentType
			](message, args.guild, punishmentConfig.amount, args);

			if (punishmentResult) {
				await punishments.create({
					id: null,
					guildId: args.guild.id,
					memberId: message.author.id,
					punishmentType: punishmentConfig.punishmentType,
					amount: punishmentConfig.amount,
					args: punishmentConfig.args,
					reason: 'automod',
					creatorId: null
				});
				this.logPunishmentModAction(
					args.guild,
					message.author,
					amount,
					punishmentConfig.punishmentType
				);
			}
		}
	}

	private async invites(message: Message, args: Arguments): Promise<boolean> {
		if (!args.settings.autoModInvitesEnabled) {
			return false;
		}
		const inviteLinks = ['invites.referralranks.com'];
		let hasInviteLink = inviteLinks.some(link => {
			return message.content.indexOf(link) >= 0;
		});
		if (hasInviteLink) {
			return true;
		}

		let regex = new RegExp(
			/(https?:\/\/)?(www\.)?(discord\.(gg|io|me|li)|discordapp\.com\/invite)\/.+[a-zA-Z0-9]/
		);
		let matches = message.content.match(regex);
		hasInviteLink = matches && matches.length > 0;
		return hasInviteLink;
	}

	private async links(message: Message, args: Arguments): Promise<boolean> {
		if (!args.settings.autoModLinksEnabled) {
			return false;
		}

		let matches = this.getLinks(message);
		let hasLink = matches && matches.length > 0;
		if (!hasLink) {
			return false;
		}

		let whitelist = args.settings.autoModLinksWhitelist;
		let blacklist = args.settings.autoModLinksBlacklist;

		if (whitelist) {
			// If both are enabled, it should also be this case
			// All links will be rejected, except the ones on the whitelist
			let links = whitelist.map(link => link.trim());
			return matches.every(match => links.indexOf(match) > -1);
		} else if (blacklist) {
			// All links will be accepted, except the ones on the blacklist
			let links = blacklist.map(link => link.trim());
			return matches.some(match => links.indexOf(match) > -1);
		} else {
			// All links will be rejected
			return hasLink;
		}
	}

	public getLinks(message: Message): RegExpMatchArray {
		let regex = new RegExp(
			/https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{2,256}\.\w{2,6}\b([-a-zA-Z0-9@:%_\+.~#?&//=]*)/g
		);
		return message.content.match(regex);
	}

	private async words(message: Message, args: Arguments): Promise<boolean> {
		if (!args.settings.autoModWordsEnabled) {
			return false;
		}
		let blacklist = args.settings.autoModWordsBlacklist;
		if (!blacklist) {
			return false;
		}
		if (blacklist.length === 0) {
			return false;
		}

		let words = blacklist;
		let content = message.content.toLowerCase();

		let hasBlacklistedWords = words.some(word => content.includes(word));

		return hasBlacklistedWords;
	}

	private async allCaps(message: Message, args: Arguments): Promise<boolean> {
		if (!args.settings.autoModAllCapsEnabled) {
			return false;
		}

		let minCharacters = Number(args.settings.autoModAllCapsMinCharacters);
		if (isNaN(minCharacters)) {
			return false;
		}

		let percentageCaps = Number(args.settings.autoModAllCapsPercentageCaps);
		if (isNaN(percentageCaps)) {
			return false;
		}

		if (message.content.length < minCharacters) {
			return false;
		}

		let numUppercase =
			message.content.length - message.content.replace(/[A-Z]/g, '').length;
		return numUppercase / message.content.length > percentageCaps / 100;
	}

	private async duplicateText(
		message: Message,
		args: Arguments
	): Promise<boolean> {
		if (!args.settings.autoModDuplicateTextEnabled) {
			return false;
		}

		let timeframe = args.settings.autoModDuplicateTextTimeframeInSeconds;

		let cachedMessages = this.messageCache.get(
			`${args.guild.id}-${message.author.id}`
		);
		if (cachedMessages.length === 1) {
			return false;
		} else {
			// Filter old messages
			cachedMessages = cachedMessages.filter(
				m => moment().diff(m.createdAt, 'second') < timeframe
			);
			// Filter current message
			cachedMessages = cachedMessages.filter(
				m =>
					!(m.createdAt === message.createdAt && m.content === message.content)
			);
			let lastMessages = cachedMessages.map(m => m.content.toLowerCase());
			return lastMessages.indexOf(message.content.toLowerCase()) >= 0;
		}
	}

	private async quickMessages(
		message: Message,
		args: Arguments
	): Promise<boolean> {
		if (!args.settings.autoModQuickMessagesEnabled) {
			return false;
		}

		let numberOfMessages = args.settings.autoModQuickMessagesNumberOfMessages;
		let timeframe = args.settings.autoModQuickMessagesTimeframeInSeconds;

		let cachedMessages = this.messageCache.get(
			`${args.guild.id}-${message.author.id}`
		);
		if (cachedMessages.length === 1) {
			return false;
		} else {
			cachedMessages = cachedMessages.filter(
				m => moment().diff(m.createdAt, 'second') < timeframe
			);
			return cachedMessages.length >= numberOfMessages;
		}
	}

	private async mentionUsers(
		message: Message,
		args: Arguments
	): Promise<boolean> {
		if (!args.settings.autoModMentionUsersEnabled) {
			return false;
		}
		let maxMentions = Number(
			args.settings.autoModMentionUsersMaxNumberOfMentions
		);
		if (isNaN(maxMentions)) {
			return false;
		}

		return message.mentions.length > maxMentions;
	}

	private async mentionRoles(
		message: Message,
		args: Arguments
	): Promise<boolean> {
		if (!args.settings.autoModMentionRolesEnabled) {
			return false;
		}
		let maxMentions = Number(
			args.settings.autoModMentionRolesMaxNumberOfMentions
		);
		if (isNaN(maxMentions)) {
			return false;
		}

		return message.roleMentions.length > maxMentions;
	}

	private async emojis(message: Message, args: Arguments): Promise<boolean> {
		if (!args.settings.autoModEmojisEnabled) {
			return false;
		}
		let maxEmojis = Number(args.settings.autoModEmojisMaxNumberOfEmojis);
		if (isNaN(maxEmojis)) {
			return;
		}

		return this.countEmojis(message) > maxEmojis;
	}

	public countEmojis(message: Message): number {
		let nofEmojis = 0;

		/* tslint:disable-next-line:max-line-length */
		const regex = /\u{1F3F4}(?:\u{E0067}\u{E0062}(?:\u{E0065}\u{E006E}\u{E0067}|\u{E0077}\u{E006C}\u{E0073}|\u{E0073}\u{E0063}\u{E0074})\u{E007F}|\u200D\u2620\uFE0F)|\u{1F469}\u200D\u{1F469}\u200D(?:\u{1F466}\u200D\u{1F466}|\u{1F467}\u200D[\u{1F466}\u{1F467}])|\u{1F468}(?:\u200D(?:\u2764\uFE0F\u200D(?:\u{1F48B}\u200D)?\u{1F468}|[\u{1F468}\u{1F469}]\u200D(?:\u{1F466}\u200D\u{1F466}|\u{1F467}\u200D[\u{1F466}\u{1F467}])|\u{1F466}\u200D\u{1F466}|\u{1F467}\u200D[\u{1F466}\u{1F467}]|[\u{1F33E}\u{1F373}\u{1F393}\u{1F3A4}\u{1F3A8}\u{1F3EB}\u{1F3ED}\u{1F4BB}\u{1F4BC}\u{1F527}\u{1F52C}\u{1F680}\u{1F692}\u{1F9B0}-\u{1F9B3}])|[\u{1F3FB}-\u{1F3FF}]\u200D[\u{1F33E}\u{1F373}\u{1F393}\u{1F3A4}\u{1F3A8}\u{1F3EB}\u{1F3ED}\u{1F4BB}\u{1F4BC}\u{1F527}\u{1F52C}\u{1F680}\u{1F692}\u{1F9B0}-\u{1F9B3}])|\u{1F469}\u200D(?:\u2764\uFE0F\u200D(?:\u{1F48B}\u200D[\u{1F468}\u{1F469}]|[\u{1F468}\u{1F469}])|[\u{1F33E}\u{1F373}\u{1F393}\u{1F3A4}\u{1F3A8}\u{1F3EB}\u{1F3ED}\u{1F4BB}\u{1F4BC}\u{1F527}\u{1F52C}\u{1F680}\u{1F692}\u{1F9B0}-\u{1F9B3}])|\u{1F469}\u200D\u{1F466}\u200D\u{1F466}|(?:\u{1F441}\uFE0F\u200D\u{1F5E8}|\u{1F469}[\u{1F3FB}-\u{1F3FF}]\u200D[\u2695\u2696\u2708]|\u{1F468}(?:[\u{1F3FB}-\u{1F3FF}]\u200D[\u2695\u2696\u2708]|\u200D[\u2695\u2696\u2708])|(?:[\u26F9\u{1F3CB}\u{1F3CC}\u{1F575}]\uFE0F|[\u{1F46F}\u{1F93C}\u{1F9DE}\u{1F9DF}])\u200D[\u2640\u2642]|[\u26F9\u{1F3CB}\u{1F3CC}\u{1F575}][\u{1F3FB}-\u{1F3FF}]\u200D[\u2640\u2642]|[\u{1F3C3}\u{1F3C4}\u{1F3CA}\u{1F46E}\u{1F471}\u{1F473}\u{1F477}\u{1F481}\u{1F482}\u{1F486}\u{1F487}\u{1F645}-\u{1F647}\u{1F64B}\u{1F64D}\u{1F64E}\u{1F6A3}\u{1F6B4}-\u{1F6B6}\u{1F926}\u{1F937}-\u{1F939}\u{1F93D}\u{1F93E}\u{1F9B8}\u{1F9B9}\u{1F9D6}-\u{1F9DD}](?:[\u{1F3FB}-\u{1F3FF}]\u200D[\u2640\u2642]|\u200D[\u2640\u2642])|\u{1F469}\u200D[\u2695\u2696\u2708])\uFE0F|\u{1F469}\u200D\u{1F467}\u200D[\u{1F466}\u{1F467}]|\u{1F469}\u200D\u{1F469}\u200D[\u{1F466}\u{1F467}]|\u{1F468}(?:\u200D(?:[\u{1F468}\u{1F469}]\u200D[\u{1F466}\u{1F467}]|[\u{1F466}\u{1F467}])|[\u{1F3FB}-\u{1F3FF}])|\u{1F3F3}\uFE0F\u200D\u{1F308}|\u{1F469}\u200D\u{1F467}|\u{1F469}[\u{1F3FB}-\u{1F3FF}]\u200D[\u{1F33E}\u{1F373}\u{1F393}\u{1F3A4}\u{1F3A8}\u{1F3EB}\u{1F3ED}\u{1F4BB}\u{1F4BC}\u{1F527}\u{1F52C}\u{1F680}\u{1F692}\u{1F9B0}-\u{1F9B3}]|\u{1F469}\u200D\u{1F466}|\u{1F1F6}\u{1F1E6}|\u{1F1FD}\u{1F1F0}|\u{1F1F4}\u{1F1F2}|\u{1F469}[\u{1F3FB}-\u{1F3FF}]|\u{1F1ED}[\u{1F1F0}\u{1F1F2}\u{1F1F3}\u{1F1F7}\u{1F1F9}\u{1F1FA}]|\u{1F1EC}[\u{1F1E6}\u{1F1E7}\u{1F1E9}-\u{1F1EE}\u{1F1F1}-\u{1F1F3}\u{1F1F5}-\u{1F1FA}\u{1F1FC}\u{1F1FE}]|\u{1F1EA}[\u{1F1E6}\u{1F1E8}\u{1F1EA}\u{1F1EC}\u{1F1ED}\u{1F1F7}-\u{1F1FA}]|\u{1F1E8}[\u{1F1E6}\u{1F1E8}\u{1F1E9}\u{1F1EB}-\u{1F1EE}\u{1F1F0}-\u{1F1F5}\u{1F1F7}\u{1F1FA}-\u{1F1FF}]|\u{1F1F2}[\u{1F1E6}\u{1F1E8}-\u{1F1ED}\u{1F1F0}-\u{1F1FF}]|\u{1F1F3}[\u{1F1E6}\u{1F1E8}\u{1F1EA}-\u{1F1EC}\u{1F1EE}\u{1F1F1}\u{1F1F4}\u{1F1F5}\u{1F1F7}\u{1F1FA}\u{1F1FF}]|\u{1F1FC}[\u{1F1EB}\u{1F1F8}]|\u{1F1FA}[\u{1F1E6}\u{1F1EC}\u{1F1F2}\u{1F1F3}\u{1F1F8}\u{1F1FE}\u{1F1FF}]|\u{1F1F0}[\u{1F1EA}\u{1F1EC}-\u{1F1EE}\u{1F1F2}\u{1F1F3}\u{1F1F5}\u{1F1F7}\u{1F1FC}\u{1F1FE}\u{1F1FF}]|\u{1F1EF}[\u{1F1EA}\u{1F1F2}\u{1F1F4}\u{1F1F5}]|\u{1F1F8}[\u{1F1E6}-\u{1F1EA}\u{1F1EC}-\u{1F1F4}\u{1F1F7}-\u{1F1F9}\u{1F1FB}\u{1F1FD}-\u{1F1FF}]|\u{1F1EE}[\u{1F1E8}-\u{1F1EA}\u{1F1F1}-\u{1F1F4}\u{1F1F6}-\u{1F1F9}]|\u{1F1FF}[\u{1F1E6}\u{1F1F2}\u{1F1FC}]|\u{1F1EB}[\u{1F1EE}-\u{1F1F0}\u{1F1F2}\u{1F1F4}\u{1F1F7}]|\u{1F1F5}[\u{1F1E6}\u{1F1EA}-\u{1F1ED}\u{1F1F0}-\u{1F1F3}\u{1F1F7}-\u{1F1F9}\u{1F1FC}\u{1F1FE}]|\u{1F1E9}[\u{1F1EA}\u{1F1EC}\u{1F1EF}\u{1F1F0}\u{1F1F2}\u{1F1F4}\u{1F1FF}]|\u{1F1F9}[\u{1F1E6}\u{1F1E8}\u{1F1E9}\u{1F1EB}-\u{1F1ED}\u{1F1EF}-\u{1F1F4}\u{1F1F7}\u{1F1F9}\u{1F1FB}\u{1F1FC}\u{1F1FF}]|\u{1F1E7}[\u{1F1E6}\u{1F1E7}\u{1F1E9}-\u{1F1EF}\u{1F1F1}-\u{1F1F4}\u{1F1F6}-\u{1F1F9}\u{1F1FB}\u{1F1FC}\u{1F1FE}\u{1F1FF}]|[#\*0-9]\uFE0F\u20E3|\u{1F1F1}[\u{1F1E6}-\u{1F1E8}\u{1F1EE}\u{1F1F0}\u{1F1F7}-\u{1F1FB}\u{1F1FE}]|\u{1F1E6}[\u{1F1E8}-\u{1F1EC}\u{1F1EE}\u{1F1F1}\u{1F1F2}\u{1F1F4}\u{1F1F6}-\u{1F1FA}\u{1F1FC}\u{1F1FD}\u{1F1FF}]|\u{1F1F7}[\u{1F1EA}\u{1F1F4}\u{1F1F8}\u{1F1FA}\u{1F1FC}]|\u{1F1FB}[\u{1F1E6}\u{1F1E8}\u{1F1EA}\u{1F1EC}\u{1F1EE}\u{1F1F3}\u{1F1FA}]|\u{1F1FE}[\u{1F1EA}\u{1F1F9}]|[\u{1F3C3}\u{1F3C4}\u{1F3CA}\u{1F46E}\u{1F471}\u{1F473}\u{1F477}\u{1F481}\u{1F482}\u{1F486}\u{1F487}\u{1F645}-\u{1F647}\u{1F64B}\u{1F64D}\u{1F64E}\u{1F6A3}\u{1F6B4}-\u{1F6B6}\u{1F926}\u{1F937}-\u{1F939}\u{1F93D}\u{1F93E}\u{1F9B8}\u{1F9B9}\u{1F9D6}-\u{1F9DD}][\u{1F3FB}-\u{1F3FF}]|[\u26F9\u{1F3CB}\u{1F3CC}\u{1F575}][\u{1F3FB}-\u{1F3FF}]|[\u261D\u270A-\u270D\u{1F385}\u{1F3C2}\u{1F3C7}\u{1F442}\u{1F443}\u{1F446}-\u{1F450}\u{1F466}\u{1F467}\u{1F470}\u{1F472}\u{1F474}-\u{1F476}\u{1F478}\u{1F47C}\u{1F483}\u{1F485}\u{1F4AA}\u{1F574}\u{1F57A}\u{1F590}\u{1F595}\u{1F596}\u{1F64C}\u{1F64F}\u{1F6C0}\u{1F6CC}\u{1F918}-\u{1F91C}\u{1F91E}\u{1F91F}\u{1F930}-\u{1F936}\u{1F9B5}\u{1F9B6}\u{1F9D1}-\u{1F9D5}][\u{1F3FB}-\u{1F3FF}]|[\u261D\u26F9\u270A-\u270D\u{1F385}\u{1F3C2}-\u{1F3C4}\u{1F3C7}\u{1F3CA}-\u{1F3CC}\u{1F442}\u{1F443}\u{1F446}-\u{1F450}\u{1F466}-\u{1F469}\u{1F46E}\u{1F470}-\u{1F478}\u{1F47C}\u{1F481}-\u{1F483}\u{1F485}-\u{1F487}\u{1F4AA}\u{1F574}\u{1F575}\u{1F57A}\u{1F590}\u{1F595}\u{1F596}\u{1F645}-\u{1F647}\u{1F64B}-\u{1F64F}\u{1F6A3}\u{1F6B4}-\u{1F6B6}\u{1F6C0}\u{1F6CC}\u{1F918}-\u{1F91C}\u{1F91E}\u{1F91F}\u{1F926}\u{1F930}-\u{1F939}\u{1F93D}\u{1F93E}\u{1F9B5}\u{1F9B6}\u{1F9B8}\u{1F9B9}\u{1F9D1}-\u{1F9DD}][\u{1F3FB}-\u{1F3FF}]?|[\u231A\u231B\u23E9-\u23EC\u23F0\u23F3\u25FD\u25FE\u2614\u2615\u2648-\u2653\u267F\u2693\u26A1\u26AA\u26AB\u26BD\u26BE\u26C4\u26C5\u26CE\u26D4\u26EA\u26F2\u26F3\u26F5\u26FA\u26FD\u2705\u270A\u270B\u2728\u274C\u274E\u2753-\u2755\u2757\u2795-\u2797\u27B0\u27BF\u2B1B\u2B1C\u2B50\u2B55\u{1F004}\u{1F0CF}\u{1F18E}\u{1F191}-\u{1F19A}\u{1F1E6}-\u{1F1FF}\u{1F201}\u{1F21A}\u{1F22F}\u{1F232}-\u{1F236}\u{1F238}-\u{1F23A}\u{1F250}\u{1F251}\u{1F300}-\u{1F320}\u{1F32D}-\u{1F335}\u{1F337}-\u{1F37C}\u{1F37E}-\u{1F393}\u{1F3A0}-\u{1F3CA}\u{1F3CF}-\u{1F3D3}\u{1F3E0}-\u{1F3F0}\u{1F3F4}\u{1F3F8}-\u{1F43E}\u{1F440}\u{1F442}-\u{1F4FC}\u{1F4FF}-\u{1F53D}\u{1F54B}-\u{1F54E}\u{1F550}-\u{1F567}\u{1F57A}\u{1F595}\u{1F596}\u{1F5A4}\u{1F5FB}-\u{1F64F}\u{1F680}-\u{1F6C5}\u{1F6CC}\u{1F6D0}-\u{1F6D2}\u{1F6EB}\u{1F6EC}\u{1F6F4}-\u{1F6F9}\u{1F910}-\u{1F93A}\u{1F93C}-\u{1F93E}\u{1F940}-\u{1F945}\u{1F947}-\u{1F970}\u{1F973}-\u{1F976}\u{1F97A}\u{1F97C}-\u{1F9A2}\u{1F9B0}-\u{1F9B9}\u{1F9C0}-\u{1F9C2}\u{1F9D0}-\u{1F9FF}]|[#\*0-9\xA9\xAE\u203C\u2049\u2122\u2139\u2194-\u2199\u21A9\u21AA\u231A\u231B\u2328\u23CF\u23E9-\u23F3\u23F8-\u23FA\u24C2\u25AA\u25AB\u25B6\u25C0\u25FB-\u25FE\u2600-\u2604\u260E\u2611\u2614\u2615\u2618\u261D\u2620\u2622\u2623\u2626\u262A\u262E\u262F\u2638-\u263A\u2640\u2642\u2648-\u2653\u265F\u2660\u2663\u2665\u2666\u2668\u267B\u267E\u267F\u2692-\u2697\u2699\u269B\u269C\u26A0\u26A1\u26AA\u26AB\u26B0\u26B1\u26BD\u26BE\u26C4\u26C5\u26C8\u26CE\u26CF\u26D1\u26D3\u26D4\u26E9\u26EA\u26F0-\u26F5\u26F7-\u26FA\u26FD\u2702\u2705\u2708-\u270D\u270F\u2712\u2714\u2716\u271D\u2721\u2728\u2733\u2734\u2744\u2747\u274C\u274E\u2753-\u2755\u2757\u2763\u2764\u2795-\u2797\u27A1\u27B0\u27BF\u2934\u2935\u2B05-\u2B07\u2B1B\u2B1C\u2B50\u2B55\u3030\u303D\u3297\u3299\u{1F004}\u{1F0CF}\u{1F170}\u{1F171}\u{1F17E}\u{1F17F}\u{1F18E}\u{1F191}-\u{1F19A}\u{1F1E6}-\u{1F1FF}\u{1F201}\u{1F202}\u{1F21A}\u{1F22F}\u{1F232}-\u{1F23A}\u{1F250}\u{1F251}\u{1F300}-\u{1F321}\u{1F324}-\u{1F393}\u{1F396}\u{1F397}\u{1F399}-\u{1F39B}\u{1F39E}-\u{1F3F0}\u{1F3F3}-\u{1F3F5}\u{1F3F7}-\u{1F4FD}\u{1F4FF}-\u{1F53D}\u{1F549}-\u{1F54E}\u{1F550}-\u{1F567}\u{1F56F}\u{1F570}\u{1F573}-\u{1F57A}\u{1F587}\u{1F58A}-\u{1F58D}\u{1F590}\u{1F595}\u{1F596}\u{1F5A4}\u{1F5A5}\u{1F5A8}\u{1F5B1}\u{1F5B2}\u{1F5BC}\u{1F5C2}-\u{1F5C4}\u{1F5D1}-\u{1F5D3}\u{1F5DC}-\u{1F5DE}\u{1F5E1}\u{1F5E3}\u{1F5E8}\u{1F5EF}\u{1F5F3}\u{1F5FA}-\u{1F64F}\u{1F680}-\u{1F6C5}\u{1F6CB}-\u{1F6D2}\u{1F6E0}-\u{1F6E5}\u{1F6E9}\u{1F6EB}\u{1F6EC}\u{1F6F0}\u{1F6F3}-\u{1F6F9}\u{1F910}-\u{1F93A}\u{1F93C}-\u{1F93E}\u{1F940}-\u{1F945}\u{1F947}-\u{1F970}\u{1F973}-\u{1F976}\u{1F97A}\u{1F97C}-\u{1F9A2}\u{1F9B0}-\u{1F9B9}\u{1F9C0}-\u{1F9C2}\u{1F9D0}-\u{1F9FF}]\uFE0F/gu;
		let matches = message.content.match(regex);
		if (matches) {
			nofEmojis = matches.length;
		}

		const discordEmojiRegex = /<a?:.+?:\d+>/g;
		let discordEmojiMatches = message.content.match(discordEmojiRegex);
		if (discordEmojiMatches) {
			nofEmojis += discordEmojiMatches.length;
		}

		return nofEmojis;
	}

	//////////////////////////////
	// PUNISHMENT FUNCTIONS
	//////////////////////////////

	private async ban(
		message: Message,
		guild: Guild,
		amount: number,
		args: Arguments
	) {
		let success = false;
		const embed = this.createPunishmentEmbed('AutoModerator');
		embed.thumbnail = { url: message.member.avatarURL };

		let [error] = await to(
			this.dmMember(guild, message.member, PunishmentType.ban, {
				strikeAmount: amount
			})
		);

		if (error) {
			embed.description = `Tried to auto-mod ${
				message.member
			}, but couldn't send them a DM.`;
			this.logToModChannel(message, embed);
		}

		[error] = await to(message.member.ban(7, 'automod'));

		if (error) {
			embed.description = `${
				message.member.username
			} could not be banned.\n${error}`;
		} else {
			embed.description = `${
				message.member.username
			} has been banned because he surpassed ${amount} strikes.`;
			success = true;
		}
		this.sendAndDelete(message, embed, args.settings);
		return success;
	}

	private async kick(
		message: Message,
		guild: Guild,
		amount: number,
		args: Arguments
	) {
		let success = false;
		await this.dmMember(guild, message.member, PunishmentType.kick, {
			strikeAmount: amount
		});

		const embed = this.createPunishmentEmbed('AutoModerator');
		embed.thumbnail = { url: message.member.avatarURL };

		let [error] = await to(message.member.kick('automod'));

		if (error) {
			embed.description = `${
				message.member.username
			} could not be kicked.\n${error}`;
		} else {
			embed.description = `${
				message.member.username
			} has been kicked because he surpassed ${amount} strikes.`;
			success = true;
		}

		this.sendAndDelete(message, embed, args.settings);
		return success;
	}

	private async softban(
		message: Message,
		guild: Guild,
		amount: number,
		args: Arguments
	) {
		let success = false;
		await this.dmMember(guild, message.member, PunishmentType.softban, {
			strikeAmount: amount
		});

		const embed = this.createPunishmentEmbed('AutoModerator');
		embed.thumbnail = { url: message.member.avatarURL };

		let [error] = await to(message.member.ban(7, 'automod'));
		if (!error) {
			[error] = await to(message.member.unban('softban'));
		}

		if (error) {
			embed.description = `${
				message.member.username
			} could not be softbanned.\n${error}`;
		} else {
			embed.description = `${
				message.member.username
			} has been softbanned because he surpassed ${amount} strikes.`;
			success = true;
		}

		this.sendAndDelete(message, embed, args.settings);
		return success;
	}

	private async warn(
		message: Message,
		guild: Guild,
		amount: number,
		args: Arguments
	) {
		let success = false;
		await this.dmMember(guild, message.member, PunishmentType.warn, {
			strikeAmount: amount
		});

		const embed = this.createPunishmentEmbed('AutoModerator');
		embed.thumbnail = { url: message.member.avatarURL };
		embed.description = `${
			message.member.username
		} has been warned because he surpassed ${amount} strikes.`;

		this.sendAndDelete(message, embed, args.settings);
		return success;
	}

	private async mute(
		message: Message,
		guild: Guild,
		amount: number,
		args: Arguments
	) {
		let success = false;
		await this.dmMember(guild, message.member, PunishmentType.mute, {
			strikeAmount: amount
		});

		let mutedRole = args.settings.mutedRole;

		const embed = this.createPunishmentEmbed('AutoModerator');
		embed.thumbnail = { url: message.member.avatarURL };

		if (!mutedRole || !guild.roles.has(mutedRole)) {
			embed.description = `Muted role is not set.`;
		} else {
			let [error] = await to(
				message.member.addRole(mutedRole, 'AutoMod muted')
			);
			if (error) {
				embed.description = `Could not mute member. ${error}`;
			} else {
				embed.description = `${
					message.member.username
				} has been muted because he surpassed ${amount} strikes.`;
			}
		}

		this.sendAndDelete(message, embed, args.settings);
		return success;
	}

	private async sendAndDelete(
		message: Message,
		embed: Embed,
		settings: SettingsObject
	) {
		if (
			settings.autoModDeleteBotMessage &&
			settings.autoModDeleteBotMessageTimeoutInSeconds === 0
		) {
			return;
		}
		let reply = await this.client.sendReply(message, embed);
		if (settings.autoModDeleteBotMessage) {
			setTimeout(
				() => reply.delete(),
				settings.autoModDeleteBotMessageTimeoutInSeconds * 1000
			);
		}
	}

	public createPunishmentEmbed(name: string, icon?: string) {
		let object = icon ? { name: name, icon_url: icon } : { name: name };
		const embed = this.client.createEmbed({
			author: object
		});
		return embed;
	}

	public async dmMember(
		guild: Guild,
		member: Member,
		action: PunishmentType,
		args: PunishmentDetails
	) {
		let dmChannel = await member.user.getDMChannel();
		let message = '';
		if (action === PunishmentType.ban) {
			message = `You have been banned from the server ${guild.name}`;
		} else if (action === PunishmentType.kick) {
			message = `You have been kicked from the server ${guild.name}`;
		} else if (action === PunishmentType.softban) {
			message = `You have been softbanned on the server ${guild.name}`;
		} else if (action === PunishmentType.mute) {
			message = `You have been muted on the server ${guild.name}`;
		} else if (action === PunishmentType.warn) {
			message = `You have been warned on the server ${guild.name}`;
		}
		if (args.reason) {
			message += `\n\n**Reason**: ${args.reason}`;
		} else if (args.strikeAmount) {
			message += `\n\n**Reason**: You reached **${
				args.strikeAmount
			}** strikes.`;
		}
		return await dmChannel.createMessage(message);
	}

	private async logToModChannel(message: Message, embed: Embed) {
		await this.client.sendReply(message, embed);
	}
}

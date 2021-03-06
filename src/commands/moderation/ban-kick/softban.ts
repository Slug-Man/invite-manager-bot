import { Member, Message } from 'eris';

import { IMClient } from '../../../client';
import {
	MemberResolver,
	NumberResolver,
	StringResolver
} from '../../../resolvers';
import { punishments, PunishmentType } from '../../../sequelize';
import { CommandGroup, ModerationCommand, Permissions } from '../../../types';
import { isPunishable, to } from '../../../util';
import { Command, Context } from '../../Command';

export default class extends Command {
	public constructor(client: IMClient) {
		super(client, {
			name: ModerationCommand.softBan,
			aliases: ['soft-ban'],
			args: [
				{
					name: 'user',
					resolver: MemberResolver,
					required: true
				},
				{
					name: 'deleteMessageDays',
					resolver: NumberResolver
				},
				{
					name: 'reason',
					resolver: StringResolver,
					rest: true
				}
			],
			group: CommandGroup.Moderation,
			strict: true,
			guildOnly: true
		});
	}

	public async action(
		message: Message,
		[targetMember, deleteMessageDays, reason]: [Member, number, string],
		{ guild, me, settings, t }: Context
	): Promise<any> {
		if (this.client.config.ownerGuildIds.indexOf(guild.id) === -1) {
			return;
		}

		const embed = this.client.mod.createPunishmentEmbed(
			targetMember.username,
			targetMember.avatarURL
		);

		if (me.permission.has(Permissions.BAN_MEMBERS)) {
			embed.description = t('ban.softBan.missingPermissions');
		} else if (isPunishable(guild, targetMember, message.member, me)) {
			let [error] = await to(targetMember.ban(deleteMessageDays, reason));
			if (error) {
				embed.description = t('cmd.softBan.error');
			} else {
				[error] = await to(targetMember.unban('softban'));
				if (error) {
					embed.description = t('cmd.softBan.unBanError');
				} else {
					embed.description = t('cmd.softBan.done');
					let punishment = await punishments.create({
						id: null,
						guildId: guild.id,
						memberId: targetMember.id,
						punishmentType: PunishmentType.softban,
						amount: 0,
						args: '',
						reason: reason,
						creatorId: message.author.id
					});
					const logEmbed = this.client.mod.createPunishmentEmbed(
						targetMember.username,
						targetMember.avatarURL
					);
					logEmbed.description = `**Punishment ID**: ${punishment.id}\n`;
					logEmbed.description += `**Target**: ${targetMember}\n`;
					logEmbed.description += `**Target**: ${targetMember.username}#${
						targetMember.discriminator
					} (ID: ${targetMember.id})\n`;
					logEmbed.description += `**Action**: ${punishment.punishmentType}\n`;
					logEmbed.description += `**Mod**: ${message.author.username}\n`;
					logEmbed.description += `**Reason**: ${reason}\n`;
					this.client.logModAction(guild, logEmbed);
				}
			}
		} else {
			embed.description = t('cmd.ban.canNotSoftBan');
		}

		let response = await this.client.sendReply(message, embed);

		if (settings.modPunishmentSoftbanDeleteMessage) {
			const func = () => {
				message.delete();
				response.delete();
			};
			setTimeout(func, 4000);
		}
	}
}

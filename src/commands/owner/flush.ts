import { Message } from 'eris';

import { IMClient } from '../../client';
import { StringResolver } from '../../resolvers';
import { OwnerCommand, ShardCommand } from '../../types';
import { Command, Context } from '../Command';

export default class extends Command {
	public constructor(client: IMClient) {
		super(client, {
			name: OwnerCommand.flush,
			aliases: ['owner-flush', 'of'],
			args: [
				{
					name: 'guildId',
					resolver: StringResolver
				}
			],
			strict: true,
			hidden: true,
			guildOnly: false
		});
	}

	public async action(
		message: Message,
		[guildId]: [string],
		{ guild }: Context
	): Promise<any> {
		if (this.client.config.ownerGuildIds.indexOf(guild.id) === -1) {
			return;
		}

		if (isNaN(parseInt(guildId, 10))) {
			return this.client.sendReply(message, 'Invalid guild id ' + guildId);
		}

		const { shard, result } = this.client.rabbitmq.sendCommandToGuild(guildId, {
			cmd: ShardCommand.FLUSH_CACHE,
			id: message.id,
			guildId
		});

		if (result) {
			this.client.sendReply(
				message,
				`Sent command to flush all caches of guild ${guildId} to shard ${shard}`
			);
		} else {
			this.client.sendReply(message, `RabbitMQ returned false`);
		}
	}
}

import { SlashCommandBuilder } from 'discord.js';
import { createEmbed } from '../../utils/embeds.js';
import { getEconomyData, setEconomyData } from '../../utils/economy.js';
import { withErrorHandling, createError, ErrorTypes } from '../../utils/errorHandler.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

const GIG_COOLDOWN = 45 * 60 * 1000;

const GIG_ACTIVITIES = [
    { name: 'Freelance Design Job', min: 120, max: 450, risk: 0.2 },
    { name: 'Event Staff Gig', min: 220, max: 700, risk: 0.25 },
    { name: 'Night Shift Gig', min: 320, max: 900, risk: 0.3 },
    { name: 'VIP Event Booking', min: 550, max: 1400, risk: 0.35 },
    { name: 'Exclusive Production Job', min: 850, max: 2200, risk: 0.4 },
];

const POSITIVE_OUTCOMES = [
    'Your project exceeded expectations and the client paid a bonus.',
    'A premium booking paid far above average.',
    'Your shift was packed and highly profitable.',
    'Extra work came through and your payout jumped.',
];

const FINE_OUTCOMES = [
    'A venue compliance issue resulted in a fine.',
    'A scheduling error triggered a service fee.',
    'You were charged a penalty for a contract violation.',
];

const ROBBED_OUTCOMES = [
    'A fake client chargeback wiped out part of your earnings.',
    'A scam booking took a chunk of your cash.',
    'A fraudulent account tricked you out of some money.',
];

const LOSS_OUTCOMES = [
    'The project flopped and you had to cover operating costs.',
    'You burned budget on preparation and made no return.',
    'The shift went sideways and left you in the red.',
];

function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomChoice(items) {
    return items[Math.floor(Math.random() * items.length)];
}

function resolveOutcome(activity, wallet) {
    const successChance = Math.max(0.35, 0.55 - activity.risk * 0.2);
    const fineChance = 0.22;
    const robbedChance = 0.2;
    const roll = Math.random();

    if (roll < successChance) {
        const amount = randomInt(activity.min, activity.max);
        return {
            type: 'payout',
            delta: amount,
            message: randomChoice(POSITIVE_OUTCOMES),
            title: `${activity.name} - Payout`
        };
    }

    const remainingAfterSuccess = roll - successChance;

    if (remainingAfterSuccess < fineChance) {
        const maxFine = Math.min(wallet, Math.max(150, Math.floor(activity.max * 0.4)));
        const minFine = Math.min(maxFine, Math.max(50, Math.floor(activity.min * 0.2)));
        const amount = maxFine > 0 ? randomInt(minFine, maxFine) : 0;
        return {
            type: 'fine',
            delta: -amount,
            message: randomChoice(FINE_OUTCOMES),
            title: `${activity.name} - Fined`
        };
    }

    if (remainingAfterSuccess < fineChance + robbedChance) {
        const maxRobbed = Math.min(wallet, Math.max(200, Math.floor(wallet * 0.35)));
        const minRobbed = Math.min(maxRobbed, Math.max(75, Math.floor(wallet * 0.1)));
        const amount = maxRobbed > 0 ? randomInt(minRobbed, maxRobbed) : 0;
        return {
            type: 'robbed',
            delta: -amount,
            message: randomChoice(ROBBED_OUTCOMES),
            title: `${activity.name} - Robbed`
        };
    }

    const maxLoss = Math.min(wallet, Math.max(100, Math.floor(activity.max * 0.3)));
    const minLoss = Math.min(maxLoss, Math.max(40, Math.floor(activity.min * 0.15)));
    const amount = maxLoss > 0 ? randomInt(minLoss, maxLoss) : 0;
    return {
        type: 'loss',
        delta: -amount,
        message: randomChoice(LOSS_OUTCOMES),
        title: `${activity.name} - Loss`
    };
}

export default {
    data: new SlashCommandBuilder()
        .setName('gig')
        .setDescription('Take a risky gig for a random payout or loss'),

    execute: withErrorHandling(async (interaction, config, client) => {
        const deferred = await InteractionHelper.safeDefer(interaction);
        if (!deferred) return;

        const userId = interaction.user.id;
        const guildId = interaction.guildId;
        const now = Date.now();

        logger.debug(`[ECONOMY] Gig command started for ${userId}`, { userId, guildId });

        const userData = await getEconomyData(client, guildId, userId);

        if (!userData) {
            throw createError(
                'Failed to load economy data for gig command',
                ErrorTypes.DATABASE,
                'Failed to load your economy data. Please try again later.',
                { userId, guildId }
            );
        }

        // Read the renamed field first, but accept the legacy field so existing
        // economy records keep their cooldown/history after the command rename.
        const lastGig = userData.lastGig ?? userData.lastSlut ?? 0;

        if (now - lastGig < GIG_COOLDOWN) {
            const remainingTime = lastGig + GIG_COOLDOWN - now;
            throw createError(
                'Gig cooldown active',
                ErrorTypes.RATE_LIMIT,
                `You need to wait before you can work again! Try again in **${Math.ceil(remainingTime / 60000)}** minutes.`,
                { timeRemaining: remainingTime, cooldownType: 'gig' }
            );
        }

        const activity = randomChoice(GIG_ACTIVITIES);
        const outcome = resolveOutcome(activity, userData.wallet || 0);

        userData.lastGig = now;
        userData.totalGigs = (userData.totalGigs ?? userData.totalSluts ?? 0) + 1;
        userData.totalGigEarnings = (userData.totalGigEarnings ?? userData.totalSlutEarnings ?? 0) + Math.max(0, outcome.delta);
        userData.totalGigLosses = (userData.totalGigLosses ?? userData.totalSlutLosses ?? 0) + Math.max(0, -outcome.delta);
        userData.failedGigs = (userData.failedGigs ?? userData.failedSluts ?? 0) + (outcome.type !== 'payout' ? 1 : 0);

        userData.wallet = Math.max(0, (userData.wallet || 0) + outcome.delta);

        await setEconomyData(client, guildId, userId, userData);

        logger.info('[ECONOMY_TRANSACTION] Gig activity resolved', {
            userId,
            guildId,
            activity: activity.name,
            outcomeType: outcome.type,
            amountDelta: outcome.delta,
            newWallet: userData.wallet,
            timestamp: new Date().toISOString()
        });

        const amountLabel = `${outcome.delta >= 0 ? '+' : '-'}$${Math.abs(outcome.delta).toLocaleString()}`;
        const summaryLines = [
            outcome.message,
            `💸 **Net Result:** ${amountLabel}`,
            `💳 **Current Balance:** $${userData.wallet.toLocaleString()}`,
            `📊 **Total Gigs:** ${userData.totalGigs}`,
            `💵 **Total Earned:** $${(userData.totalGigEarnings || 0).toLocaleString()}`,
            `🧾 **Total Lost:** $${(userData.totalGigLosses || 0).toLocaleString()}`
        ];

        const embed = createEmbed({
            title: outcome.title,
            description: summaryLines.join('\n'),
            color: outcome.delta >= 0 ? 'success' : 'error',
            timestamp: true
        });

        await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
    }, { command: 'gig' })
};

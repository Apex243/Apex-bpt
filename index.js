const { Client, EmbedBuilder } = require('discord.js');
const { GameDig } = require('gamedig'); // ✅ v5: named export

const TOKEN = process.env.TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;

const HOST = '148.113.30.96';
const PORT = 7044;
const RESTART_HOUR = 6; // UTC

const UPDATE_INTERVAL_MS = 30_000;
const MESSAGE_SEARCH_LIMIT = 50;

const client = new Client({ intents: [] });

let statusMessage = null;
let consecutiveErrors = 0;

function getRestartCountdown() {
    const now = new Date();
    const restart = new Date();
    restart.setUTCHours(RESTART_HOUR, 0, 0, 0);
    if (restart <= now) restart.setUTCDate(restart.getUTCDate() + 1);

    const diff = restart - now;
    const hours = Math.floor(diff / 3_600_000);
    const minutes = Math.floor((diff % 3_600_000) / 60_000);
    return `${hours}h ${minutes}m`;
}

client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);

    const channel = await client.channels.fetch(CHANNEL_ID);
    const messages = await channel.messages.fetch({ limit: MESSAGE_SEARCH_LIMIT });
    statusMessage = messages.find(m => m.author.id === client.user.id) ?? null;

    if (!statusMessage) {
        statusMessage = await channel.send({ content: 'Loading server status...' });
    }

    updateStatus();
    setInterval(updateStatus, UPDATE_INTERVAL_MS);
});

async function updateStatus() {
    try {
        const start = Date.now();

        // ✅ v5 API: GameDig.query is a static method on the named export
        const state = await GameDig.query({
            type: 'samp',
            host: HOST,
            port: PORT,
        });

        const ping = Date.now() - start;
        consecutiveErrors = 0;

        const embed = new EmbedBuilder()
            .setColor('#00ff66')
            .setTitle('🌆 ASTRIX CITY ROLEPLAY')
            .setDescription('Unique Sandbox Built For Your Stories!')
            .addFields(
                { name: '🟢 STATUS',       value: 'Online',                                      inline: true },
                { name: '👥 PLAYERS',      value: `${state.players.length}/${state.maxplayers}`, inline: true },
                { name: '📡 PING',         value: `${ping}ms`,                                   inline: true },
                { name: '🎮 GAMEMODE',     value: state.raw?.gamemode ?? 'Unknown' },
                { name: '🗺️ MAP',          value: state.map ?? 'San Andreas' },
                { name: '🌐 SERVER',       value: `${HOST}:${PORT}` },
                { name: '⏰ NEXT RESTART', value: getRestartCountdown() },
                { name: '🎮 CONNECT',      value: `\`${HOST}:${PORT}\`` },
            )
            .setFooter({ text: 'Last Updated' })
            .setTimestamp();

        await sendOrEdit({ content: '', embeds: [embed] });

    } catch (err) {
        consecutiveErrors++;
        // Log on first failure, then every 10th to avoid log spam
        if (consecutiveErrors === 1 || consecutiveErrors % 10 === 0) {
            console.error(`[updateStatus] Query failed (x${consecutiveErrors}):`, err.message);
        }

        const embed = new EmbedBuilder()
            .setColor('#ff0000')
            .setTitle('🌆 ASTRIX CITY ROLEPLAY')
            .setDescription('Unique Sandbox Built For Your Stories!')
            .addFields(
                { name: '🔴 STATUS', value: 'Offline' },
                { name: '🌐 SERVER', value: `${HOST}:${PORT}` },
            )
            .setTimestamp();

        await sendOrEdit({ content: '', embeds: [embed] });
    }
}

// Edits the existing status message, or re-sends if it was deleted
async function sendOrEdit(payload) {
    try {
        if (statusMessage) {
            await statusMessage.edit(payload);
        } else {
            const channel = await client.channels.fetch(CHANNEL_ID);
            statusMessage = await channel.send(payload);
        }
    } catch (err) {
        if (err.code === 10008) {
            // Unknown Message — it was deleted, send a fresh one
            statusMessage = null;
            const channel = await client.channels.fetch(CHANNEL_ID);
            statusMessage = await channel.send(payload);
        } else {
            console.error('[sendOrEdit]', err);
        }
    }
}

client.login(TOKEN);
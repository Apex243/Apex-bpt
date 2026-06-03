const { Client, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { GameDig } = require('gamedig');
const dgram = require('dgram');

const TOKEN = process.env.TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;

const HOST = '148.113.30.96';
const PORT = 7044;
const RESTART_HOUR = 6; // UTC
const INSTAGRAM_URL = 'https://www.instagram.com/_apex_roleplay_?igsh=MXI3NnNkcXo1YXRreA=='; // ← change to your Instagram link
const YOUTUBE_URL = 'https://youtube.com/@apex-roleplay?si=TIAHJ6zUcnWpeLm1'; // ← change to your YouTube channel link

const UPDATE_INTERVAL_MS = 30_000;
const MESSAGE_SEARCH_LIMIT = 50;
const SAMP_TIMEOUT_MS = 5000;

function getButtons() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('copy_ip')
            .setLabel('📋 Copy IP')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setLabel('📸 Instagram')
            .setStyle(ButtonStyle.Link)
            .setURL(INSTAGRAM_URL),
        new ButtonBuilder()
            .setLabel('▶️ YouTube')
            .setStyle(ButtonStyle.Link)
            .setURL(YOUTUBE_URL),
    );
}

const client = new Client({ intents: [] });

let statusMessage = null;
let consecutiveErrors = 0;
let serverOnlineSince = null; // tracks when the server first came online

function getUptime() {
    if (!serverOnlineSince) return 'N/A';
    const diff = Date.now() - serverOnlineSince;
    const hours = Math.floor(diff / 3_600_000);
    const minutes = Math.floor((diff % 3_600_000) / 60_000);
    const seconds = Math.floor((diff % 60_000) / 1_000);
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
}

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

/**
 * Method 1: Direct SA-MP/open.mp UDP query using the SA-MP query protocol.
 * open.mp is fully backward-compatible with the SA-MP query protocol.
 */
function querySAMPDirect(host, port) {
    return new Promise((resolve, reject) => {
        const socket = dgram.createSocket('udp4');
        const timeout = setTimeout(() => {
            socket.close();
            reject(new Error(`Direct UDP query timed out after ${SAMP_TIMEOUT_MS}ms`));
        }, SAMP_TIMEOUT_MS);

        const ipParts = host.split('.').map(Number);
        const buf = Buffer.alloc(11);
        buf.write('SAMP', 0, 'ascii');
        buf[4] = ipParts[0];
        buf[5] = ipParts[1];
        buf[6] = ipParts[2];
        buf[7] = ipParts[3];
        buf.writeUInt16LE(port, 8);
        buf[10] = 0x69; // 'i' = info query

        socket.on('error', (err) => {
            clearTimeout(timeout);
            socket.close();
            reject(err);
        });

        socket.on('message', (msg) => {
            clearTimeout(timeout);
            socket.close();

            try {
                if (msg.length < 11) return reject(new Error('Response too short'));

                let offset = 11;
                offset += 1; // passworded
                const players = msg.readUInt16LE(offset); offset += 2;
                const maxPlayers = msg.readUInt16LE(offset); offset += 2;

                const hostnameLen = msg.readUInt32LE(offset); offset += 4;
                const hostname = msg.slice(offset, offset + hostnameLen).toString('ascii'); offset += hostnameLen;

                const gamemodeLen = msg.readUInt32LE(offset); offset += 4;
                const gamemode = msg.slice(offset, offset + gamemodeLen).toString('ascii');

                resolve({ players, maxPlayers, hostname, gamemode });
            } catch (e) {
                reject(new Error('Parse error: ' + e.message));
            }
        });

        socket.send(buf, 0, buf.length, port, host, (err) => {
            if (err) {
                clearTimeout(timeout);
                socket.close();
                reject(err);
            }
        });
    });
}

/**
 * Method 2: Gamedig query (supports open.mp via 'samp' type).
 */
async function queryViaGameDig(host, port) {
    const state = await GameDig.query({
        type: 'samp',
        host,
        port,
        socketTimeout: SAMP_TIMEOUT_MS,
        attemptTimeout: SAMP_TIMEOUT_MS + 1000,
    });
    return {
        players: state.players.length,
        maxPlayers: state.maxplayers,
        hostname: state.name,
        gamemode: state.raw?.gamemode ?? 'Unknown',
    };
}

/**
 * Tries direct UDP first, falls back to GameDig if that fails.
 */
async function queryServer(host, port) {
    try {
        const result = await querySAMPDirect(host, port);
        console.log(`[query] Direct UDP success — ${result.players}/${result.maxPlayers}`);
        return result;
    } catch (directErr) {
        console.warn(`[query] Direct UDP failed (${directErr.message}), trying GameDig...`);
        const result = await queryViaGameDig(host, port);
        console.log(`[query] GameDig success — ${result.players}/${result.maxPlayers}`);
        return result;
    }
}

client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);

    let channel;
    try {
        channel = await client.channels.fetch(CHANNEL_ID);
    } catch (err) {
        if (err.code === 50001) {
            console.error(
                `[ready] FATAL: Bot does not have access to channel ${CHANNEL_ID}.\n` +
                `  → Make sure the bot is in the server and has "View Channel" permission.\n` +
                `  → Also verify the CHANNEL_ID env var on Render is correct.`
            );
        } else {
            console.error('[ready] Failed to fetch channel:', err.message);
        }
        process.exit(1); // exit so Render restarts the service
    }

    const messages = await channel.messages.fetch({ limit: MESSAGE_SEARCH_LIMIT });

    // Find ALL old bot messages to avoid duplicate embeds
    const botMessages = messages.filter(m => m.author.id === client.user.id);

    if (botMessages.size === 0) {
        // No existing message — send a fresh one
        statusMessage = await channel.send({ content: 'Loading server status...' });
        console.log('[ready] No existing status message found, sent a new one.');
    } else {
        // Keep the newest one, delete all others
        const sorted = botMessages.sort((a, b) => b.createdTimestamp - a.createdTimestamp);
        statusMessage = sorted.first();

        const extras = sorted.filter(m => m.id !== statusMessage.id);
        if (extras.size > 0) {
            console.log(`[ready] Found ${extras.size} duplicate bot message(s), deleting...`);
            for (const [, msg] of extras) {
                await msg.delete().catch(() => { }); // ignore if already deleted
            }
        }

        console.log(`[ready] Using existing status message (id: ${statusMessage.id})`);
    }

    updateStatus();
    setInterval(updateStatus, UPDATE_INTERVAL_MS);
});

async function updateStatus() {
    try {
        const start = Date.now();
        const state = await queryServer(HOST, PORT);
        const ping = Date.now() - start;

        consecutiveErrors = 0;
        if (!serverOnlineSince) serverOnlineSince = Date.now(); // start uptime timer on first success

        const embed = new EmbedBuilder()
            .setColor(0xFF6600) // orange = yellow + red mix
            .setTitle('**APEX CITY**')
            .addFields(
                { name: '> STATUS', value: '```🟢 Online```', inline: true },
                { name: '> PLAYERS', value: `\`\`\`${state.players}/${state.maxPlayers}\`\`\``, inline: true },
                { name: '\u200b', value: '\u200b', inline: false },
                { name: '> PING', value: `\`\`\`${ping}ms\`\`\``, inline: true },
                { name: '> UPTIME', value: `\`\`\`${getUptime()}\`\`\``, inline: true },
                { name: '> ALLOWED CLIENT', value: '```0.3.7```', inline: false },
                { name: '> CONNECT', value: `\`\`\`${HOST}:${PORT}\`\`\``, inline: false },
            )
            .setImage('https://cdn.discordapp.com/attachments/1397147173858185316/1397251153959321681/1679989159197.png?ex=6a20fc4a&is=6a1faaca&hm=626b04884d37132eb224296d907b18ed1dbe1f21a51d577a67cf0ca16564b347')
            .setFooter({
                text: 'Sharing IP may lead you to a ban.',
                iconURL: 'https://cdn.discordapp.com/attachments/1397147173858185316/1397251192391860264/apex_5499BFE.gif?ex=6a20fc53&is=6a1faad3&hm=e12ddec136d099f7346b30fcc1039a1be3f5e63585c83af3b51a6a64b9ba2426',
            })
            .setTimestamp();

        await sendOrEdit({ content: '', embeds: [embed], components: [getButtons()] });

    } catch (err) {
        consecutiveErrors++;
        if (consecutiveErrors === 1 || consecutiveErrors % 10 === 0) {
            console.error(`[updateStatus] Both query methods failed (x${consecutiveErrors}):`, err.message);
        }

        serverOnlineSince = null; // reset uptime when server goes offline

        const embed = new EmbedBuilder()
            .setColor(0xFF0000) // red = offline
            .setTitle('**APEX CITY**')
            .addFields(
                { name: '> STATUS', value: '```🔴 Offline```', inline: true },
                { name: '> PLAYERS', value: '```N/A```', inline: true },
                { name: '\u200b', value: '\u200b', inline: false },
                { name: '> PING', value: '```N/A```', inline: true },
                { name: '> UPTIME', value: '```N/A```', inline: true },
                { name: '> ALLOWED CLIENT', value: '```0.3.7```', inline: false },
                { name: '> CONNECT', value: `\`\`\`${HOST}:${PORT}\`\`\``, inline: false },
            )
            .setImage('https://cdn.discordapp.com/attachments/1397147173858185316/1397251153959321681/1679989159197.png?ex=6a20fc4a&is=6a1faaca&hm=626b04884d37132eb224296d907b18ed1dbe1f21a51d577a67cf0ca16564b347')
            .setFooter({
                text: 'Sharing IP may lead you to a ban.',
                iconURL: 'https://cdn.discordapp.com/attachments/1397147173858185316/1397251192391860264/apex_5499BFE.gif?ex=6a20fc53&is=6a1faad3&hm=e12ddec136d099f7346b30fcc1039a1be3f5e63585c83af3b51a6a64b9ba2426',
            })
            .setTimestamp();

        await sendOrEdit({ content: '', embeds: [embed], components: [getButtons()] });
    }
}

// Handle button interactions
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;
    if (interaction.customId === 'copy_ip') {
        await interaction.reply({
            content: [
                '### 📋 Server IP',
                '> Select and copy the IP below:',
                `\`\`\`${HOST}:${PORT}\`\`\``,
                '-# Paste it in SA-MP / open.mp connect box.',
            ].join('\n'),
            ephemeral: true,
        });
    }
});

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
            // Message was deleted — resend
            statusMessage = null;
            const channel = await client.channels.fetch(CHANNEL_ID);
            statusMessage = await channel.send(payload);
        } else if (err.code === 50001) {
            console.error('[sendOrEdit] Missing Access — bot lost permission to the channel.');
        } else {
            console.error('[sendOrEdit]', err);
        }
    }
}

client.login(TOKEN);
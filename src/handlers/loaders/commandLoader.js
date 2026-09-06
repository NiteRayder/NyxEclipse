import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { Collection } from 'discord.js';
import { logger } from '../../utils/logger.js';
import botConfig from '../../config/bot.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MAX_COMMANDS = 100;
const COMMAND_COUNT_WARN_THRESHOLD = 90;
const MAX_DESCRIPTION_LENGTH = 100;
const MAX_CHOICE_NAME_LENGTH = 100;
const MAX_CHOICE_VALUE_LENGTH = 100;

function getSubcommandInfo(commandData) {
    const subcommands = [];

    if (commandData.options) {
        for (const option of commandData.options) {
            if (option.type === 1) {
                subcommands.push(option.name);
            } else if (option.type === 2 && option.options) {
                for (const subOption of option.options) {
                    if (subOption.type === 1) {
                        subcommands.push(`${option.name}/${subOption.name}`);
                    }
                }
            }
        }
    }

    return subcommands;
}

async function getAllFiles(directory, fileList = []) {
    const files = await fs.readdir(directory, { withFileTypes: true });

    for (const file of files) {
        const filePath = path.join(directory, file.name);

        if (file.isDirectory()) {
            if (file.name === 'modules') {
                continue;
            }
            await getAllFiles(filePath, fileList);
        } else if (file.name.endsWith('.js')) {
            fileList.push(filePath);
        }
    }

    return fileList;
}

export async function loadCommands(client) {
    client.commands = new Collection();
    const commandsPath = path.join(__dirname, '../../commands');
    const commandFiles = await getAllFiles(commandsPath);

    logger.info(`Found ${commandFiles.length} command files to load`);

    const uniqueCommandNames = new Set();

    for (const filePath of commandFiles) {
        try {
            const normalizedPath = filePath.replace(/\\/g, '/');
            const commandName = path.basename(filePath, '.js');
            const commandDir = path.dirname(filePath);
            const category = path.basename(commandDir);

            const commandModule = await import(`file://${filePath}`);
            const command = commandModule.default || commandModule;

            if (!command.data || !command.execute) {
                logger.warn(`Command at ${filePath} is missing required "data" or "execute" property.`);
                continue;
            }

            command.category = category;
            command.filePath = normalizedPath;

            const primaryCommandName = command.data.name;

            if (!uniqueCommandNames.has(primaryCommandName)) {
                uniqueCommandNames.add(primaryCommandName);
                client.commands.set(primaryCommandName, command);
            } else {
                logger.warn(`Duplicate command name "${primaryCommandName}" found at ${filePath}; skipping duplicate.`);
                continue;
            }

            const subcommands = getSubcommandInfo(command.data.toJSON());

            logger.info(`Loaded command: ${primaryCommandName} from ${normalizedPath} (category: ${category})`);

            if (subcommands.length > 0) {
                logger.info(`  - Subcommands: ${subcommands.join(', ')}`);
            }
        } catch (error) {
            logger.error(`Error loading command from ${filePath}:`, error);
        }
    }

    const uniqueCommands = new Set(client.commands.keys());
    logger.info(`Loaded ${uniqueCommands.size} commands`);
    return client.commands;
}

function collectCommandPayloads(client) {
    const commands = [];
    let totalSubcommands = 0;
    const registeredNames = new Set();

    for (const command of client.commands.values()) {
        if (!command.data || typeof command.data.toJSON !== 'function') {
            logger.warn(`Command missing data or toJSON method: ${command}`);
            continue;
        }

        const commandName = command.data.name;
        logger.debug(`Processing command for registration: ${commandName}`);

        if (registeredNames.has(commandName)) {
            logger.debug(`Skipping duplicate command: ${commandName}`);
            continue;
        }

        registeredNames.add(commandName);
        const commandJson = command.data.toJSON();
        commands.push(commandJson);
        totalSubcommands += getSubcommandInfo(commandJson).length;
    }

    return { commands, totalSubcommands };
}

function validateChoice(choice, commandName, optionPath, validationErrors) {
    if (typeof choice.name === 'string' && choice.name.length > MAX_CHOICE_NAME_LENGTH) {
        validationErrors.push(
            `Command ${commandName} ${optionPath} choice ${choice.name} has a name longer than ${MAX_CHOICE_NAME_LENGTH} chars`
        );
    }

    if (typeof choice.value === 'string' && choice.value.length > MAX_CHOICE_VALUE_LENGTH) {
        validationErrors.push(
            `Command ${commandName} ${optionPath} choice ${choice.name} has a value longer than ${MAX_CHOICE_VALUE_LENGTH} chars`
        );
    }
}

function validateOption(option, commandName, optionPath, validationErrors) {
    if (typeof option.name === 'string' && option.name.length > 32) {
        validationErrors.push(`Command ${commandName} ${optionPath} has a name longer than 32 chars`);
    }

    if (typeof option.description === 'string' && option.description.length > MAX_DESCRIPTION_LENGTH) {
        validationErrors.push(`Command ${commandName} ${optionPath} has a description longer than ${MAX_DESCRIPTION_LENGTH} chars`);
    }

    if (Array.isArray(option.choices)) {
        for (const choice of option.choices) {
            validateChoice(choice, commandName, optionPath, validationErrors);
        }
    }

    if (Array.isArray(option.options)) {
        for (const subOption of option.options) {
            validateOption(subOption, commandName, `${optionPath} subcommand ${option.name}`, validationErrors);
        }
    }
}

function validateCommands(commands) {
    const validationErrors = [];

    for (const cmd of commands) {
        if (typeof cmd.name === 'string' && cmd.name.length > 32) {
            validationErrors.push(`Command ${cmd.name} has a name longer than 32 chars`);
        }

        if (typeof cmd.description === 'string' && cmd.description.length > MAX_DESCRIPTION_LENGTH) {
            validationErrors.push(`Command ${cmd.name} has a description longer than ${MAX_DESCRIPTION_LENGTH} chars`);
        }

        if (Array.isArray(cmd.options)) {
            for (const option of cmd.options) {
                validateOption(option, cmd.name, `option ${option.name}`, validationErrors);
            }
        }
    }

    if (validationErrors.length > 0) {
        logger.error('Command validation failed. Errors:');
        validationErrors.forEach((error) => logger.error(`  - ${error}`));
        throw new Error(`Command validation failed with ${validationErrors.length} errors`);
    }
}

function prepareCommandsForRegistration(commands) {
    if (commands.length >= COMMAND_COUNT_WARN_THRESHOLD) {
        logger.warn(`Command count (${commands.length}) is near Discord's ${MAX_COMMANDS} global command limit`);
    }

    if (commands.length > MAX_COMMANDS) {
        throw new Error(`Command count (${commands.length}) exceeds Discord's ${MAX_COMMANDS} global command limit`);
    }

    return commands;
}

async function registerGlobalCommands(client, clientId, commands, totalSubcommands) {
    if (!clientId) {
        throw new Error('CLIENT_ID is required for slash command registration');
    }

    if (!client.rest) {
        throw new Error('Discord REST client is not available for slash command registration');
    }

    logger.info(`Preparing to register ${totalSubcommands + commands.length} commands globally`);
    logger.info('Validating commands before registration...');
    validateCommands(commands);
    logger.info('Command validation passed');

    const commandsToRegister = prepareCommandsForRegistration(commands);

    if (botConfig.commands?.deleteCommands) {
        logger.info('Clearing existing global commands before registration...');
        await client.rest.put(`/applications/${clientId}/commands`, { body: [] });
    }

    logger.info(`Registering ${commandsToRegister.length} global commands...`);
    await client.rest.put(`/applications/${clientId}/commands`, { body: commandsToRegister });
    logger.info(`Successfully registered ${commandsToRegister.length} global commands`);
    logger.info('Global command registration completed');
}

export async function registerCommands(client, options = {}) {
    const { clientId = null } = options;

    try {
        const { commands, totalSubcommands } = collectCommandPayloads(client);
        await registerGlobalCommands(client, clientId, commands, totalSubcommands);
    } catch (error) {
        logger.error('Error registering commands:', error);
        throw error;
    }
}

export async function reloadCommand(client, commandName) {
    const command = client.commands.get(commandName);

    if (!command) {
        return { success: false, message: `Command "${commandName}" not found` };
    }

    try {
        const commandPath = path.resolve(command.filePath);
        const moduleUrl = pathToFileURL(commandPath);
        moduleUrl.searchParams.set('t', Date.now().toString());

        const commandModule = await import(moduleUrl.href);
        const newCommand = commandModule.default || commandModule;

        if (!newCommand?.data || !newCommand?.execute) {
            throw new Error(`Reloaded command "${commandName}" is missing data or execute`);
        }

        newCommand.category = command.category;
        newCommand.filePath = command.filePath;
        client.commands.set(commandName, newCommand);

        logger.info(`Reloaded command: ${commandName}`);
        return { success: true, message: `Successfully reloaded command "${commandName}"` };
    } catch (error) {
        logger.error(`Error reloading command "${commandName}":`, error);
        return { success: false, message: `Error reloading command: ${error.message}` };
    }
}

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const spawn = require('child_process').spawn;
const url = require('url');

const RTM_EVENTS = require('@slack/client').RTM_EVENTS;

const winston = require('winston');


function download(host, path, token) {
    const options = {
        host,
        path,
        headers: {
            Authorization: `Bearer ${token}`,
        },
    };

    return new Promise((resolve, reject) => {
        https.get(options, (res) => {
            resolve(res);
        }).on('error', (error) => {
            reject(error);
        });
    });
}


function save(path, sourceStream) {
    return new Promise((resolve, reject) => {
        const targetStream = fs.createWriteStream(path);
        sourceStream.pipe(targetStream);

        targetStream.on('finish', () => {
            resolve(path);
        }).on('error', (error) => {
            reject(error);
        });
    });
}


function execute(name, config, sourceFolder) {
    const dockerArgs = [
        'run',
        '--rm',
        '-m', `${config.memory}M`,
        '-w', '/local',
        '-v', `${sourceFolder}:/local`,
        config.image,
        'timeout', config.timeout,
        config.command,
        name,
    ];

    return new Promise((resolve) => {
        const docker = spawn('docker', dockerArgs);
        let output = '';
        let error = '';
        docker.stdout.on('data', (data) => {
            output = data.toString();
        });

        docker.stderr.on('data', (data) => {
            error = data.toString();
        });

        docker.on('close', (code) => {
            const result = [output || error];

            if (code > 0) {
                result.push(`Your snippet failed with exit code: ${code}`);
            }

            resolve(result.join('\n'));
        });
    });
}


function loadConfig(config, name) {
    const language = config.plugins.eval.languages[name];
    return {
        timeout: language.timeout || config.plugins.eval.timeout,
        crop: language.crop || config.plugins.eval.crop,
        memory: language.memory || config.plugins.eval.memory,
        image: language.image,
        command: language.command,
    };
}

function runSnippet(web, rtm, config, file) {
    // Provide a random name for files without one (-.x) gives errors
    let fileName = file.name;
    if (fileName.startsWith('-.')) {
        fileName = crypto.randomBytes(4).toString('hex');
    }

    const reply = text => web.files.comments.add(file.id, text);
    const { host, path } = url.parse(file.url_private_download);
    const language = loadConfig(config, file.filetype);

    const sourceFolder = `${__dirname}/${config.plugins.eval.folder}`;
    const fileOnDisk = `${sourceFolder}/${fileName}`;

    download(host, path, config.token)
        .then(response => save(fileOnDisk, response))
        .then(() => execute(fileName, language, sourceFolder))
        .then(text => reply(`\`\`\`${text}\`\`\``))
        .catch((error) => {
            reply(error);
            winston.error(error);
        });

    web.reactions.add('repeat', { file: file.id })
        .catch(() => {}); // bot already reacted supposedly
}

function register(id, rtm, web, config) {
    rtm.on(RTM_EVENTS.MESSAGE, (message) => {
        if (message.text
                && message.text === 'snippets support') {
            const languages = Object.keys(config.plugins.eval.languages).join(', ');
            rtm.sendMessage(`I can run: ${languages}`, message.channel);
        }

        if (message.text
                && message.text.startsWith('snippets config')) {
            const name = message.text.split(' ').pop();
            try {
                const { timeout, crop, memory } = loadConfig(config, name);
                rtm.sendMessage(`\`\`\`${name}:
            Timeout  : ${timeout} seconds
            Memory   : ${memory}MB
            Crops at : ${crop} characters\`\`\``, message.channel);
            } catch (e) {
                rtm.sendMessage(
                        `\`\`\`${name} is not supported\`\`\``,
                        message.channel);
            }
        }

        if (message.file
                && message.file.mode === 'snippet'
                && message.subtype === 'file_share'
                && config.plugins.eval.languages[message.file.filetype]) {
            runSnippet(web, rtm, config, message.file);
        }
    });


    rtm.on(RTM_EVENTS.REACTION_ADDED, (message) => {
        if (message.user !== id
                && message.item.type === 'file'
                && message.reaction === 'repeat') {
            web.files.info(message.item.file)
                .then(result => runSnippet(web, rtm, config, result.file));
        }
    });
}

module.exports = {
    register,
};
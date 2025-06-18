"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.run = run;
const core = __importStar(require("@actions/core"));
const hc = __importStar(require("@actions/http-client"));
const glob = __importStar(require("@actions/glob"));
const github = __importStar(require("@actions/github"));
const promises_1 = require("fs/promises");
const path_1 = __importDefault(require("path"));
const comment_1 = require("./comment");
// Currently, we only support numeric version.
const versionReg = /^\d+/;
/**
 * The main function for the action.
 * @returns {Promise<void>} Resolves when the action is complete.
 */
async function run() {
    try {
        const url = core.getInput('url', { required: true });
        const token = core.getInput('token', { required: true });
        const project = core.getInput('project', { required: true });
        const filePattern = core.getInput('file-pattern', { required: true });
        const validateOnly = core.getBooleanInput('validate-only');
        const checkReleaseLevel = core.getInput('check-release');
        const targets = core.getInput('targets');
        switch (checkReleaseLevel) {
            case 'SKIP':
                break;
            case 'FAIL_ON_WARNING':
                break;
            case 'FAIL_ON_ERROR':
                break;
            default:
                throw new Error(`unknown check-release value ${checkReleaseLevel}`);
        }
        if (checkReleaseLevel !== 'SKIP' && targets === '') {
            throw new Error(`targets must be set because check-release is not SKIP`);
        }
        const { serverUrl, repo, sha } = github.context;
        const pwd = process.env.GITHUB_WORKSPACE;
        const commitUrl = `${serverUrl}/${repo.owner}/${repo.repo}/commits/${sha}`;
        core.debug(`serverUrl: ${serverUrl}`);
        core.debug(`repo: ${repo.owner}/${repo.repo}`);
        core.debug(`sha: ${sha}`);
        core.debug(`commitUrl: ${commitUrl}`);
        core.debug(`pwd: ${pwd}`);
        const c = {
            url: url,
            token: token,
            c: new hc.HttpClient('create-release-action', [], {
                headers: {
                    authorization: `Bearer ${token}`
                }
            })
        };
        const globber = await glob.create(filePattern);
        const files = [];
        for await (const file of globber.globGenerator()) {
            const relativePath = path_1.default.relative(pwd, file);
            const versionM = path_1.default.basename(file).match(versionReg);
            if (!versionM) {
                core.warning(`failed to get version, ignore ${file}`);
                continue;
            }
            const version = versionM[0];
            const content = await (0, promises_1.readFile)(file, { encoding: 'base64' });
            const filename = path_1.default.parse(relativePath).name;
            let changeType = 'DDL';
            if (filename.endsWith('dml')) {
                changeType = 'DML';
            }
            if (filename.endsWith('ghost')) {
                changeType = 'DDL_GHOST';
            }
            files.push({
                path: relativePath,
                version: version,
                content: content,
                type: 'VERSIONED',
                changeType: changeType
            });
            core.debug(`file: ${relativePath}`);
            core.debug(`version: ${version}`);
            core.debug(`content: ${content}`);
            core.debug(`changeType: ${changeType}`);
        }
        if (files.length === 0) {
            throw new Error(`no migration files found, the file pattern is ${filePattern}`);
        }
        const targetList = targets.split(',');
        await doCheckRelease(c, project, files, targetList, checkReleaseLevel, validateOnly);
        if (validateOnly) {
            return;
        }
        const sheets = files.map(e => ({
            title: `sheet for ${e.path}`,
            content: e.content
        }));
        const sheetNames = await createSheets(c, project, sheets);
        if (sheetNames.length != files.length) {
            throw new Error(`expect to create ${files.length} sheets but get ${sheetNames.length}`);
        }
        const releaseFiles = [];
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const sheet = sheetNames[i];
            releaseFiles.push({
                path: file.path,
                version: file.version,
                sheet: sheet,
                type: 'VERSIONED',
                changeType: file.changeType
            });
        }
        const releaseToCreate = {
            title: `${repo.owner}/${repo.repo}@${sha}`,
            files: releaseFiles,
            vcsSource: {
                vcsType: 'GITHUB',
                url: commitUrl
            }
        };
        const release = await createRelease(c, project, releaseToCreate);
        core.info(`Release created. View at ${c.url}/${release} on Bytebase.`);
        // reject out-of-order version: using previewPlan
        await previewPlan(c, project, release, targetList);
        core.setOutput('release', release);
    }
    catch (error) {
        if (error instanceof Error)
            core.setFailed(error.message);
    }
}
async function previewPlan(c, project, release, targets) {
    const url = `${c.url}/v1/${project}:previewPlan`;
    const request = {
        release: release,
        targets: targets,
        allowOutOfOrder: true
    };
    const response = await c.c.postJson(url, request);
    if (response.statusCode !== 200) {
        throw new Error(`failed to create release, ${response.statusCode}, ${response.result?.message}`);
    }
    if (!response.result) {
        throw new Error(`expect result to be not null, get ${response.result}`);
    }
    if (response.result.outOfOrderFiles &&
        response.result.outOfOrderFiles.length > 0) {
        core.warning(`found out of order files\n${formatDatabaseFiles(response.result.outOfOrderFiles)}`);
        throw new Error(`failed to create release: found out of order files\n${formatDatabaseFiles(response.result.outOfOrderFiles)}`);
    }
    if (response.result.appliedButModifiedFiles &&
        response.result.appliedButModifiedFiles.length > 0) {
        core.warning(`found applied but modified files\n${formatDatabaseFiles(response.result.appliedButModifiedFiles)}`);
        throw new Error(`failed to create release: found applied but modified files\n${formatDatabaseFiles(response.result.appliedButModifiedFiles)}`);
    }
    return response.result.plan;
}
function formatDatabaseFiles(databaseFiles) {
    return databaseFiles
        .map(e => {
        return `e.database:` + e.files.join(',');
    })
        .join('\n');
}
async function createSheets(c, project, sheets) {
    const url = `${c.url}/v1/${project}/sheets:batchCreate`;
    const requests = sheets.map(e => {
        return {
            sheet: {
                title: e.title,
                // content should be base64 encoded.
                content: e.content
            }
        };
    });
    const response = await c.c.postJson(url, {
        requests: requests
    });
    if (response.statusCode !== 200) {
        throw new Error(`failed to create sheet, ${response.statusCode}, ${response.result?.message}`);
    }
    if (!response.result) {
        throw new Error(`expect result to be not null, get ${response.result}`);
    }
    return response.result.sheets.map(e => e.name);
}
async function createRelease(c, project, releaseToCreate) {
    const url = `${c.url}/v1/${project}/releases`;
    const response = await c.c.postJson(url, releaseToCreate);
    if (response.statusCode !== 200) {
        throw new Error(`failed to create release, ${response.statusCode}, ${response.result?.message}`);
    }
    if (!response.result) {
        throw new Error(`expect result to be not null, get ${response.result}`);
    }
    return response.result.name;
}
async function doCheckRelease(c, project, files, targets, checkReleaseLevel, validateOnly) {
    if (checkReleaseLevel === 'SKIP') {
        return;
    }
    const url = `${c.url}/v1/${project}/releases:check`;
    const filesToCheck = files.map(e => {
        return {
            path: e.path,
            statement: e.content,
            version: e.version,
            changeType: e.changeType,
            type: e.type
        };
    });
    core.debug(`filesToCheck: ${JSON.stringify(filesToCheck)}`);
    const req = {
        release: {
            files: filesToCheck
        },
        targets: targets
    };
    // Use raw fetch to handle jsonify error response body.
    const response = await c.c.post(url, JSON.stringify(req), {
        'Content-Type': 'application/json'
    });
    const body = JSON.parse(await response.readBody());
    core.debug(`check release response: ${JSON.stringify(body)}`);
    // Check for errors in the response.
    if (typeof body.message === 'string' && body.message !== '') {
        throw new Error(`failed to check release, error: ${body.message}`);
    }
    const checkReleaseResponse = body;
    // Aggregate advice by file and targets.
    // Key is combination of file and advice's specific fields.
    let adviceMapByFileTarget = new Map();
    let hasError = false;
    let hasWarning = false;
    for (const result of checkReleaseResponse.results ?? []) {
        const file = result.file;
        const target = result.target;
        const advices = result.advices;
        if (!advices) {
            continue;
        }
        for (const advice of advices) {
            const key = `${file}-${advice.status}-${advice.code}-${advice.line}-${advice.column}-${advice.title}`;
            if (!adviceMapByFileTarget.has(key)) {
                adviceMapByFileTarget.set(key, {
                    file: file,
                    advice: advice,
                    targets: []
                });
            }
            adviceMapByFileTarget.get(key)?.targets.push(target);
            if (advice.status === 'ERROR') {
                hasError = true;
            }
            if (advice.status === 'WARNING') {
                hasWarning = true;
            }
        }
    }
    for (const [_, value] of adviceMapByFileTarget) {
        const { file, advice, targets } = value;
        const annotation = `::${advice.status} file=${file},line=${advice.line},col=${advice.column},title=${advice.title} (${advice.code})::${advice.content}. Targets: ${targets.join(', ')} https://www.bytebase.com/docs/reference/error-code/advisor#${advice.code}`;
        // Emit annotations for each advice
        core.info(annotation);
    }
    // If validateOnly is true, upsert a comment with the check results.
    if (validateOnly) {
        try {
            await (0, comment_1.upsertComment)(checkReleaseResponse);
        }
        catch (error) {
            core.warning(`failed to create comment, error: ${error}`);
        }
    }
    if (hasError || (hasWarning && checkReleaseLevel === 'FAIL_ON_WARNING')) {
        throw new Error(`Release checks find ERROR or WARNING violations`);
    }
}
//# sourceMappingURL=main.js.map
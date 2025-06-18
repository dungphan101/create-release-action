import * as core from '@actions/core'
import * as hc from '@actions/http-client'
import * as glob from '@actions/glob'
import * as github from '@actions/github'
import { readFile } from 'fs/promises'
import path from 'path'
import {
  ChangeType,
  CheckReleaseResponse,
  httpClient,
  Release,
  ReleaseFile,
  Sheet,
  File,
  DatabaseFiles
} from './type'
import { upsertComment } from './comment'

// Currently, we only support numeric version.
const versionReg = /^\d+/

/**
 * The main function for the action.
 * @returns {Promise<void>} Resolves when the action is complete.
 */
export async function run(): Promise<void> {
  try {
    const url = core.getInput('url', { required: true })
    const token = core.getInput('token', { required: true })
    const project = core.getInput('project', { required: true })
    const filePattern = core.getInput('file-pattern', { required: true })
    const validateOnly = core.getBooleanInput('validate-only')

    const checkReleaseLevel = core.getInput('check-release')
    const targets = core.getInput('targets')

    switch (checkReleaseLevel) {
      case 'SKIP':
        break
      case 'FAIL_ON_WARNING':
        break
      case 'FAIL_ON_ERROR':
        break
      default:
        throw new Error(`unknown check-release value ${checkReleaseLevel}`)
    }

    if (checkReleaseLevel !== 'SKIP' && targets === '') {
      throw new Error(`targets must be set because check-release is not SKIP`)
    }

    const { serverUrl, repo, sha } = github.context
    const pwd = process.env.GITHUB_WORKSPACE as string
    const commitUrl = `${serverUrl}/${repo.owner}/${repo.repo}/commits/${sha}`

    core.debug(`serverUrl: ${serverUrl}`)
    core.debug(`repo: ${repo.owner}/${repo.repo}`)
    core.debug(`sha: ${sha}`)
    core.debug(`commitUrl: ${commitUrl}`)
    core.debug(`pwd: ${pwd}`)

    const c: httpClient = {
      url: url,
      token: token,
      c: new hc.HttpClient('create-release-action', [], {
        headers: {
          authorization: `Bearer ${token}`
        }
      })
    }

    const globber = await glob.create(filePattern)
    const files: File[] = []
    for await (const file of globber.globGenerator()) {
      const relativePath = path.relative(pwd, file)
      const versionM = path.basename(file).match(versionReg)
      if (!versionM) {
        core.warning(`failed to get version, ignore ${file}`)
        continue
      }
      const version = versionM[0]
      const content = await readFile(file, { encoding: 'base64' })

      const filename = path.parse(relativePath).name
      let changeType: ChangeType = 'DDL'
      if (filename.endsWith('dml')) {
        changeType = 'DML'
      }
      if (filename.endsWith('ghost')) {
        changeType = 'DDL_GHOST'
      }

      files.push({
        path: relativePath,
        version: version,
        content: content,
        type: 'VERSIONED',
        changeType: changeType
      })

      core.debug(`file: ${relativePath}`)
      core.debug(`version: ${version}`)
      core.debug(`content: ${content}`)
      core.debug(`changeType: ${changeType}`)
    }
    if (files.length === 0) {
      throw new Error(
        `no migration files found, the file pattern is ${filePattern}`
      )
    }
    
    const targetList = targets.split(',')
    
    await doCheckRelease(
      c,
      project,
      files,
      targetList,
      checkReleaseLevel,
      validateOnly
    )

    if (validateOnly) {
      return
    }

    const sheets = files.map(e => ({
      title: `sheet for ${e.path}`,
      content: e.content
    }))

    const sheetNames = await createSheets(c, project, sheets)

    if (sheetNames.length != files.length) {
      throw new Error(
        `expect to create ${files.length} sheets but get ${sheetNames.length}`
      )
    }

    const releaseFiles: ReleaseFile[] = []
    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      const sheet = sheetNames[i]
      releaseFiles.push({
        path: file.path,
        version: file.version,
        sheet: sheet,
        type: 'VERSIONED',
        changeType: file.changeType
      })
    }
    const releaseToCreate: Release = {
      title: `${repo.owner}/${repo.repo}@${sha}`,
      files: releaseFiles,
      vcsSource: {
        vcsType: 'GITHUB',
        url: commitUrl
      }
    }

    const release = await createRelease(c, project, releaseToCreate)

    core.info(`Release created. View at ${c.url}/${release} on Bytebase.`)

    // reject out-of-order version: using previewPlan
    const planToCreate = await previewPlan(c, project, release, targetList)
    
    core.setOutput('release', release)
  } catch (error) {
    if (error instanceof Error) core.setFailed(error.message)
  }
}

async function previewPlan(
  c: httpClient,
  project: string,
  release: string,
  targets: string[]
): Promise<any> {
  const url = `${c.url}/v1/${project}:previewPlan`

  const request = {
    release: release,
    targets: targets,
    allowOutOfOrder: false
  }

  const response = await c.c.postJson<{
    message: string
    plan: any
    outOfOrderFiles?: DatabaseFiles[]
    appliedButModifiedFiles?: DatabaseFiles[]
  }>(url, request)

  if (response.statusCode !== 200) {
    throw new Error(
      `failed to create release, ${response.statusCode}, ${response.result?.message}`
    )
  }

  if (!response.result) {
    throw new Error(`expect result to be not null, get ${response.result}`)
  }

  if (
    response.result.outOfOrderFiles &&
    response.result.outOfOrderFiles.length > 0
  ) {
    core.error(
      `found out of order files\n${formatDatabaseFiles(response.result.outOfOrderFiles)}`
    )
    throw new Error(
      `failed to create release: found out of order files\n${formatDatabaseFiles(response.result.outOfOrderFiles)}`
    )
  }
  if (
    response.result.appliedButModifiedFiles &&
    response.result.appliedButModifiedFiles.length > 0
  ) {
    core.warning(
      `found applied but modified files\n${formatDatabaseFiles(response.result.appliedButModifiedFiles)}`
    )
  }

  return response.result.plan
}

function formatDatabaseFiles(databaseFiles: DatabaseFiles[]): string {
  return databaseFiles
    .map(e => {
      return `e.database:` + e.files.join(',')
    })
    .join('\n')
}

async function createSheets(
  c: httpClient,
  project: string,
  sheets: Sheet[]
): Promise<string[]> {
  const url = `${c.url}/v1/${project}/sheets:batchCreate`
  const requests = sheets.map(e => {
    return {
      sheet: {
        title: e.title,
        // content should be base64 encoded.
        content: e.content
      }
    }
  })
  const response = await c.c.postJson<{
    message: string
    sheets: {
      name: string
    }[]
  }>(url, {
    requests: requests
  })

  if (response.statusCode !== 200) {
    throw new Error(
      `failed to create sheet, ${response.statusCode}, ${response.result?.message}`
    )
  }

  if (!response.result) {
    throw new Error(`expect result to be not null, get ${response.result}`)
  }

  return response.result.sheets.map(e => e.name)
}

async function createRelease(
  c: httpClient,
  project: string,
  releaseToCreate: Release
): Promise<string> {
  const url = `${c.url}/v1/${project}/releases`

  const response = await c.c.postJson<{
    message: string
    name: string
  }>(url, releaseToCreate)

  if (response.statusCode !== 200) {
    throw new Error(
      `failed to create release, ${response.statusCode}, ${response.result?.message}`
    )
  }

  if (!response.result) {
    throw new Error(`expect result to be not null, get ${response.result}`)
  }

  return response.result.name
}

async function doCheckRelease(
  c: httpClient,
  project: string,
  files: File[],
  targets: string[],
  checkReleaseLevel: 'SKIP' | 'FAIL_ON_WARNING' | 'FAIL_ON_ERROR',
  validateOnly: boolean
) {
  if (checkReleaseLevel === 'SKIP') {
    return
  }
  const url = `${c.url}/v1/${project}/releases:check`

  const filesToCheck = files.map(e => {
    return {
      path: e.path,
      statement: e.content,
      version: e.version,
      changeType: e.changeType,
      type: e.type
    }
  })

  core.debug(`filesToCheck: ${JSON.stringify(filesToCheck)}`)

  const req = {
    release: {
      files: filesToCheck
    },
    targets: targets
  }

  // Use raw fetch to handle jsonify error response body.
  const response = await c.c.post(url, JSON.stringify(req), {
    'Content-Type': 'application/json'
  })
  const body = JSON.parse(await response.readBody())
  core.debug(`check release response: ${JSON.stringify(body)}`)
  // Check for errors in the response.
  if (typeof body.message === 'string' && body.message !== '') {
    throw new Error(`failed to check release, error: ${body.message}`)
  }

  const checkReleaseResponse = body as CheckReleaseResponse

  // Aggregate advice by file and targets.
  // Key is combination of file and advice's specific fields.
  let adviceMapByFileTarget: Map<
    string,
    {
      file: string
      advice: any
      targets: string[]
    }
  > = new Map()
  let hasError = false
  let hasWarning = false
  for (const result of checkReleaseResponse.results ?? []) {
    const file = result.file
    const target = result.target
    const advices = result.advices
    if (!advices) {
      continue
    }

    for (const advice of advices) {
      const key = `${file}-${advice.status}-${advice.code}-${advice.line}-${advice.column}-${advice.title}`
      if (!adviceMapByFileTarget.has(key)) {
        adviceMapByFileTarget.set(key, {
          file: file,
          advice: advice,
          targets: []
        })
      }
      adviceMapByFileTarget.get(key)?.targets.push(target)
      if (advice.status === 'ERROR') {
        hasError = true
      }
      if (advice.status === 'WARNING') {
        hasWarning = true
      }
    }
  }

  for (const [_, value] of adviceMapByFileTarget) {
    const { file, advice, targets } = value
    const annotation = `::${advice.status} file=${file},line=${advice.line},col=${advice.column},title=${advice.title} (${advice.code})::${advice.content}. Targets: ${targets.join(', ')} https://www.bytebase.com/docs/reference/error-code/advisor#${advice.code}`
    // Emit annotations for each advice
    core.info(annotation)
  }

  // If validateOnly is true, upsert a comment with the check results.
  if (validateOnly) {
    try {
      await upsertComment(checkReleaseResponse)
    } catch (error) {
      core.warning(`failed to create comment, error: ${error}`)
    }
  }

  if (hasError || (hasWarning && checkReleaseLevel === 'FAIL_ON_WARNING')) {
    throw new Error(`Release checks find ERROR or WARNING violations`)
  }


}

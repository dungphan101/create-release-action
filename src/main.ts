import * as core from '@actions/core'
import * as hc from '@actions/http-client'
import * as glob from '@actions/glob'
import * as github from '@actions/github'
import { readFile } from 'fs/promises'
import path from 'path'

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

    const { serverUrl, repo, sha } = github.context
    const commitUrl = `${serverUrl}/${repo.owner}/${repo.repo}/commits/${sha}`

    const c: httpClient = {
      url: url,
      token: token,
      c: new hc.HttpClient('actions-create-release', [], {
        headers: {
          authorization: `Bearer ${token}`
        }
      })
    }

    const globber = await glob.create(filePattern)
    const versionReg = /^\d+/

    const files: File[] = []
    for await (const file of globber.globGenerator()) {
      const versionM = path.basename(file).match(versionReg)
      if (!versionM) {
        core.info(`failed to get version, ignore ${file}`)
        continue
      }
      const version = versionM[0]
      const content = await readFile(file, { encoding: 'base64' })

      files.push({
        path: file,
        version: version,
        content: content,
        type: 'VERSIONED'
      })
    }
    if (files.length === 0) {
      throw new Error(
        `no migration files found, the file pattern is ${filePattern}`
      )
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
        type: 'VERSIONED'
      })
    }
    const releaseToCreate: Release = {
      title: `release`,
      files: releaseFiles,
      vcsSource: {
        vcsType: 'GITHUB',
        url: commitUrl
      }
    }

    const release = await createRelease(c, project, releaseToCreate)

    core.setOutput('release', release)
  } catch (error) {
    if (error instanceof Error) core.setFailed(error.message)
  }
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

interface httpClient {
  c: hc.HttpClient
  url: string
  token: string
}

interface Sheet {
  title: string
  content: string
}

interface File {
  content: string
  path: string
  version: string
  type: 'VERSIONED'
}

interface ReleaseFile {
  path: string
  version: string
  sheet: string
  type: 'VERSIONED'
}

interface Release {
  title: string
  files: ReleaseFile[]
  vcsSource: {
    vcsType: 'GITHUB'
    url: string
  }
}

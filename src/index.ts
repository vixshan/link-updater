import * as core from '@actions/core'
import * as github from '@actions/github'
import * as fs from 'fs'
import * as path from 'path'
import { parseConfig, defaultConfigMsg } from './config'
import { processDirectory } from './fileProcessor'
import { createPullRequest } from './prCreator'
import { linkChanges as linkChangesImport } from './linkProcessor'
let linkChanges: typeof linkChangesImport = []

async function exec(command: string, args: string[]): Promise<string> {
  const { exec } = require('@actions/exec')
  let output = ''

  const options = {
    listeners: {
      stdout: (data: Buffer) => {
        output += data.toString()
      }
    }
  }

  await exec(command, args, options)
  return output.trim()
}

async function isGitTracked(file: string): Promise<boolean> {
  try {
    await exec('git', ['ls-files', '--error-unmatch', file])
    return true
  } catch {
    return false
  }
}

async function setRemoteWithToken(token: string): Promise<void> {
  const { owner, repo } = github.context.repo
  const authenticatedUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`
  await exec('git', ['remote', 'set-url', 'origin', authenticatedUrl])
}

export async function run(): Promise<void> {
  try {
    linkChanges = []

    const token = core.getInput('token')
    const configPath = core.getInput('config-path')

    core.info(`Starting with config path: ${configPath}`)

    if (!token) {
      throw new Error('GitHub token not found')
    }

    const octokit = github.getOctokit(token)
    const config = parseConfig(configPath)

    core.info('📝 Starting link updates with configuration:')
    core.info(`Paths: ${config.paths.join(', ')}`)
    core.info(`Files: ${config.files.join(', ')}`)
    core.info(`Number of link replacements: ${config.links?.length || 0}`)
    core.info(
      `Number of GitHub URL types: ${config.githubUrls?.types.length || 0}`
    )
    core.info(`Mode: ${config.createPr ? 'Pull Request' : 'Direct Commit'}`)

    let hasChanges = false

    for (const configPath of config.paths) {
      const absolutePath = path.resolve(process.cwd(), configPath)
      if (fs.existsSync(absolutePath)) {
        const pathChanges = await processDirectory(absolutePath, config)
        hasChanges = hasChanges || pathChanges
      } else {
        core.warning(`⚠️ Path not found: ${configPath}`)
      }
    }

    if (hasChanges) {
      await exec('git', [
        'config',
        '--local',
        'user.email',
        'link-updater[bot]@users.noreply.github.com'
      ])
      await exec('git', ['config', '--local', 'user.name', 'link-updater[bot]'])

      const filesToStash = []
      if (
        fs.existsSync('package.json') &&
        (await isGitTracked('package.json'))
      ) {
        filesToStash.push('package.json')
      }
      if (fs.existsSync('bun.lockb') && (await isGitTracked('bun.lockb'))) {
        filesToStash.push('bun.lockb')
      }

      if (filesToStash.length > 0) {
        await exec('git', ['stash', 'push', '--', ...filesToStash])
      }

      const tempGitignore = '.action-gitignore'
      fs.writeFileSync(tempGitignore, 'package.json\nbun.lockb\n')

      await exec('git', ['add', '--all'])

      // Reset the files we don't want to commit
      if (fs.existsSync('package.json')) {
        await exec('git', ['reset', 'HEAD', 'package.json'])
      }
      if (fs.existsSync('bun.lockb')) {
        await exec('git', ['reset', 'HEAD', 'bun.lockb'])
      }
      // Reset the temporary gitignore file
      await exec('git', ['reset', 'HEAD', tempGitignore])

      const commitMsg = config.commitMsg || defaultConfigMsg

      try {
        if (config.createPr) {
          const branchName = `link-updates-${Date.now()}`
          await exec('git', ['checkout', '-b', branchName])
          await exec('git', ['commit', '-m', commitMsg])

          await setRemoteWithToken(token)
          try {
            await exec('git', ['push', 'origin', branchName])
            await createPullRequest(octokit, branchName)
          } finally {
            await exec('git', [
              'remote',
              'set-url',
              'origin',
              `https://github.com/${github.context.repo.owner}/${github.context.repo.repo}.git`
            ])
          }
        } else {
          await exec('git', ['commit', '-m', commitMsg])

          await setRemoteWithToken(token)
          try {
            await exec('git', ['push'])
          } finally {
            await exec('git', [
              'remote',
              'set-url',
              'origin',
              `https://github.com/${github.context.repo.owner}/${github.context.repo.repo}.git`
            ])
          }
        }
      } finally {
        // Ensure cleanup happens regardless of success/failure
        if (filesToStash.length > 0) {
          try {
            await exec('git', ['stash', 'pop'])
          } catch (error) {
            core.warning('Failed to pop stash, but continuing...')
          }
        }
        // Clean up the temporary gitignore file
        if (fs.existsSync(tempGitignore)) {
          fs.unlinkSync(tempGitignore)
        }
      }

      core.info(
        config.createPr
          ? '✨ Successfully created PR with link updates!'
          : '✨ Successfully updated links and pushed changes to main!'
      )
    } else {
      core.info('ℹ️ No changes were needed')
    }
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(`Action failed: ${error.message}`)
    } else {
      core.setFailed('An unexpected error occurred')
    }
  }
}

run()

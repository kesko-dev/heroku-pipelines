const cli = require('heroku-cli-util')
const co = require('co')
const api = require('../../lib/api')
const kolkrabbi = require('../../lib/kolkrabbi-api')
const github = require('../../lib/github-api')
const prompt = require('../../lib/prompt')
const REPO_REGEX = /.+\/.+/

function getGitHubToken (token) {
  return kolkrabbi.getAccount(token).then((account) => {
    return account.github.token
  }, () => {
    throw new Error('Account not connected to GitHub.')
  })
}

function getRepo (token, name) {
  return github.getRepo(token, name).catch(() => {
    throw new Error(`Could not access the ${name} repo`)
  })
}

function createApp (heroku, { archiveURL, name, organization, pipeline, stage }) {
  const params = {
    source_blob: { url: archiveURL },
    app: { name }
  }

  if (organization) {
    params.app.organization = organization
  } else {
    params.app.personal = true
  }

  return api.createAppSetup(heroku, params).then((setup) => {
    return api.postCoupling(heroku, pipeline.id, setup.app.id, stage).then(() => {
      return setup.app
    })
  })
}

function* getNameAndRepo (args) {
  const answers = yield prompt([{
    type: 'input',
    name: 'name',
    message: 'Pipeline name',
    when () { return !args.name }
  }, {
    type: 'input',
    name: 'repo',
    message: 'GitHub repository to connect to (e.g. rails/rails)',
    when () { return !args.repo },
    validate (input) {
      if (input.match(REPO_REGEX)) return true
      return 'Must be in the format organization/rep  o'
    }
  }])

  return Object.assign(answers, args)
}

function* getSettings (branch) {
  return yield prompt([{
    type: 'confirm',
    name: 'auto_deploy',
    message: `Automatically deploy the ${branch} branch to staging?`
  }, {
    type: 'confirm',
    name: 'wait_for_ci',
    message: `Wait for CI to pass before deploying the ${branch} branch to staging?`,
    when (answers) { return answers.auto_deploy }
  }, {
    type: 'confirm',
    name: 'pull_requests.enabled',
    message: 'Enable review apps?'
  }, {
    type: 'confirm',
    name: 'pull_requests.auto_deploy',
    message: 'Automatically create review apps for every PR?',
    when (answers) { return answers.pull_requests.enabled }
  }, {
    type: 'confirm',
    name: 'pull_requests.auto_destroy',
    message: 'Automatically destroy idle review apps after 5 days?',
    when (answers) { return answers.pull_requests.enabled }
  }])
}

function* hasCIFlag (heroku) {
  let hasFlag
  try {
    hasFlag = (yield api.getAccountFeature(heroku, 'ci')).enabled
  } catch (error) {
    hasFlag = false
  }
  return hasFlag
}

function* getCISettings (organization) {
  const settings = yield prompt([{
    type: 'confirm',
    name: 'ci',
    message: 'Enable automatic Heroku CI test runs?'
  }])

  if (settings.ci && organization) {
    settings.organization = organization
  }

  return settings
}

function setupPipeline (token, app, settings, pipelineID, ciSettings = {}) {
  const promises = [kolkrabbi.updateAppLink(token, app, settings)]

  if (ciSettings.ci) {
    promises.push(
      kolkrabbi.updatePipelineRepository(token, pipelineID, ciSettings)
    )
  }

  return Promise.all(promises).then(([appLink]) => {
    return appLink
  }, (error) => {
    cli.error(error.response.body.message)
  })
}

module.exports = {
  topic: 'pipelines',
  command: 'setup',
  description: 'bootstrap a new pipeline with common settings and create a production and staging app (requires a fully formed app.json in the repo)',
  help: `Example:

  heroku pipelines:setup example githuborg/reponame -o example-org
  ? Automatically deploy the master branch to staging? Yes
  ? Wait for CI to pass before deploying the master branch to staging? Yes
  ? Enable review apps? Yes
  ? Automatically create review apps for every PR? Yes
  ? Automatically destroy idle review apps after 5 days? Yes
  Creating pipeline... done
  Linking to repo... done
  Creating ⬢ example (production app)... done
  Creating ⬢ example-staging (staging app)... done
  Configuring pipeline... done
  View your new pipeline by running \`heroku pipelines:open e5a55ffa-de3f-11e6-a245-3c15c2e6bc1e\``,
  needsApp: false,
  needsAuth: true,
  args: [
    {
      name: 'name',
      description: 'name of pipeline',
      optional: true
    },
    {
      name: 'repo',
      description: 'a GitHub repository to connect the pipeline to',
      optional: true
    }
  ],
  flags: [
    {
      name: 'organization',
      char: 'o',
      description: 'the organization which will own the apps (can also use --team)',
      hasValue: true
    },
    {
      name: 'team',
      char: 't',
      description: 'the team which will own the apps (can also use --organization)',
      hasValue: true
    }
  ],
  run: cli.command(co.wrap(function*(context, heroku) {
    const herokuToken = heroku.options.token
    const githubToken = yield getGitHubToken(herokuToken)
    const organization = context.flags.organization || context.flags.team

    const { name: pipelineName, repo: repoName } = yield getNameAndRepo(context.args)
    const repo = yield getRepo(githubToken, repoName)
    const settings = yield getSettings(repo.default_branch)

    let ciSettings
    if (yield hasCIFlag(heroku)) {
      ciSettings = yield getCISettings(organization)
    }

    const pipeline = yield cli.action(
      'Creating pipeline',
      api.createPipeline(heroku, pipelineName)
    )

    yield cli.action(
      'Linking to repo',
      kolkrabbi.createPipelineRepository(herokuToken, pipeline.id, repo.id)
    )

    const archiveURL = yield github.getArchiveURL(githubToken, repoName, repo.default_branch)

    yield cli.action(
      `Creating ${cli.color.app(pipelineName)} (production app)`,
      createApp(heroku, {
        archiveURL,
        pipeline,
        name: pipelineName,
        stage: 'production',
        organization
      })
    )

    const stagingAppName = `${pipelineName}-staging`
    const stagingApp = yield cli.action(
      `Creating ${cli.color.app(stagingAppName)} (staging app)`,
      createApp(heroku, {
        archiveURL,
        pipeline,
        name: stagingAppName,
        stage: 'staging',
        organization
      })
    )

    yield cli.action(
      'Configuring pipeline',
      setupPipeline(herokuToken, stagingApp.id, settings, pipeline.id, ciSettings)
    )

    yield cli.open(`https://dashboard.heroku.com/pipelines/${pipeline.id}`)
  }))
}

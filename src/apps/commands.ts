import { Application, Context, Octokit, Logger } from "probot";
import { render } from "../util";
import yaml from "js-yaml";
import { validate } from "jsonschema";
import {
  ReposListDeploymentsResponseItem,
  ReposGetDeploymentResponse,
  PullsGetResponse
} from "@octokit/rest";
import schema from "../schema.json";
import { canWrite } from "./auth";

const previewAnt = "application/vnd.github.ant-man-preview+json";
const previewFlash = "application/vnd.github.flash-preview+json";

function withPreview<T>(arg: T): T {
  (arg as any).headers = { accept: `${previewAnt},${previewFlash}` };
  return arg as T;
}

function logCtx(context: Context, params: any) {
  return {
    context: {
      installation: context.payload.installation,
      repo: context.payload.repository ? context.repo() : undefined
    },
    ...params
  };
}

interface Deployment {
  task: string;
  payload: any;
  environment: string;
  description: string;
  auto_merge: boolean;
}

export interface Target {
  name: string;
  auto_deploy_on: string;

  // Required contexts  are required to be matched across all deployments in the
  // target set. This is so that one deployment does not succeed before another
  // causing the set to fail.
  required_contexts: string[];

  // Environment information must be copied into all deployments.
  transient_environment: boolean;
  production_environment: boolean;

  // Deployments are the list of deployments to trigger.
  deployments: Deployment[];
}

export type Targets = { [k: string]: Target | undefined };

export async function config(
  github: Octokit,
  {
    owner,
    repo,
    ref
  }: {
    owner: string;
    repo: string;
    ref: string;
  }
): Promise<Targets> {
  const content = await github.repos.getContents({
    owner,
    repo,
    ref,
    path: `.github/deploy.yml`
  });
  const conf =
    yaml.safeLoad(Buffer.from(content.data.content, "base64").toString()) || {};
  const validation = validate(conf, schema, {
    propertyName: "config",
    allowUnknownAttributes: true
  });
  if (validation.errors.length > 0) {
    const err = validation.errors[0];
    throw new Error(`${err.property} ${err.message}`);
  }
  for (const key in conf) {
    conf[key].name = key;
    conf[key].deployments = conf[key].deployments || [];
  }
  return conf;
}

function getDeployBody(
  target: Target,
  deployment: Deployment,
  data: any
): Deployment {
  return withPreview({
    task: deployment.task || "deploy",
    transient_environment: target.transient_environment || false,
    production_environment: target.production_environment || false,
    environment: render(deployment.environment || "production", data),
    auto_merge: deployment.auto_merge || false,
    required_contexts: target.required_contexts || [],
    description: render(deployment.description, data),
    payload: {
      target: target.name,
      ...render(deployment.payload, data)
    }
  });
}

async function handlePRDeploy(context: Context, command: string) {
  context.log.info(logCtx(context, { command }), "pr deploy: handling command");
  try {
    const target = command.split(" ")[1];
    const pr = await context.github.pulls.get({
      owner: context.payload.repository.owner.login,
      repo: context.payload.repository.name,
      pull_number: context.payload.issue.number
    });

    const write = await canWrite(
      context.github,
      context.repo({ username: context.payload.comment.user.login })
    );
    if (!write) {
      context.log.info(logCtx(context, {}), "pr deploy: no write priviledges");
      return;
    }

    await deployCommit(
      context.github,
      context.log,
      context.repo({
        target,
        ref: pr.data.head.ref,
        sha: pr.data.head.sha,
        pr: pr.data
      })
    );
  } catch (error) {
    await context.github.issues.createComment({
      owner: context.payload.repository.owner.login,
      repo: context.payload.repository.name,
      issue_number: context.payload.issue.number,
      body: `:rotating_light: Failed to trigger deployment. :rotating_light:\n${error.message}`
    });
  }
}

/**
 * Deploy commit handles all the necessities of creating a conformant deployment
 * including templating and more. All deploys should go through this function.
 * We need to deploy always using the ref of a branch so that finding
 * deployments later we can query using the branch ref.
 */
export async function deployCommit(
  github: Octokit,
  log: Logger,
  {
    owner,
    repo,
    target,
    ref,
    sha,
    pr
  }: {
    owner: string;
    repo: string;
    target: string;
    ref: string;
    sha: string;
    pr?: PullsGetResponse;
  }
) {
  const logCtx = {
    deploy: { target, ref, pr },
    context: { repo: { owner, repo } }
  };
  const commit = await github.git.getCommit({ owner, repo, commit_sha: sha });

  // Params are the payload that goes into every deployment - change these in a
  // backwards compatible way always.
  const params = {
    ref,
    target,
    owner,
    repo,
    short_sha: sha.substr(0, 7),
    commit: commit.data,
    pr: pr ? pr.number : undefined,
    pull_request: pr
  };

  const conf = await config(github, { owner, repo, ref });
  const targetVal = conf[target];
  if (!targetVal) {
    log.info(logCtx, "deploy: failed - no target");
    throw new Error(`Deployment target "${target}" does not exist`);
  }
  if (targetVal.deployments.length === 0) {
    log.info(logCtx, "deploy: failed - no deployments");
    throw new Error(`Deployment target "${target}" has no deployments`);
  }

  const deployed = [];
  for (const deployment of targetVal.deployments) {
    const body = {
      owner,
      repo,
      ref,
      ...getDeployBody(targetVal, deployment, params)
    };
    try {
      log.info({ ...logCtx, body }, "deploy: deploying");
      // TODO: Handle auto_merge case correctly here.
      // https://developer.github.com/v3/repos/deployments/#merged-branch-response
      const deploy = await github.repos.createDeployment(body);
      log.info({ ...logCtx, body }, "deploy: successful");
      deployed.push(deploy.data as ReposGetDeploymentResponse);
    } catch (error) {
      log.error({ ...logCtx, error, body }, "deploy: failed");
      throw error;
    }
  }
  return deployed;
}

async function handleAutoDeploy(context: Context) {
  context.log.info("auto deploy: checking deployments");
  const config = await context.config("deploy.yml");
  for (const key in config) {
    const deployment = config[key];
    await autoDeployTarget(context, key, deployment);
  }
}

async function autoDeployTarget(
  context: Context,
  target: string,
  targetVal: Target
) {
  const autoDeploy = targetVal.auto_deploy_on;
  if (!autoDeploy) {
    return;
  }
  const ref = autoDeploy.replace("refs/", "");
  context.log.info(logCtx(context, { ref }), "auto deploy: verifying");
  const refData = await context.github.git.getRef(context.repo({ ref }));
  const sha = refData.data.object.sha;

  const deploys = await context.github.repos.listDeployments(
    context.repo({ sha })
  );
  const environments = targetVal.deployments.map(d => d.environment);
  if (deploys.data.find(d => environments.includes(d.environment))) {
    context.log.info(logCtx(context, { ref }), "auto deploy: already deployed");
    return;
  }

  context.log.info(logCtx(context, { ref }), "auto deploy: deploying");
  try {
    await deployCommit(
      context.github,
      context.log,
      context.repo({
        ref,
        sha,
        target
      })
    );
    context.log.info(logCtx(context, { ref }), "auto deploy: done");
  } catch (error) {
    context.log.error(
      context.repo({ error, ref, target }),
      "auto deploy: failed"
    );
  }
}

async function handlePRClose(context: Context) {
  const ref = context.payload.pull_request.head.ref;
  const sha = context.payload.pull_request.head.sha;
  const deployments = await context.github.repos.listDeployments(
    withPreview({ ...context.repo(), ref })
  );
  context.log.info(logCtx(context, { ref }), "pr close: listed deploys");

  // List all deployments for this pull request by environment to undeploy the
  // last deployment for every environment.
  const environments: { [env: string]: ReposListDeploymentsResponseItem } = {};
  for (const deployment of deployments.data.reverse()) {
    // Only terminate transient environments.
    if (!deployment.transient_environment) {
      context.log.info(
        logCtx(context, { ref, deployment: deployment.id }),
        "pr close: not transient"
      );
      continue;
    }
    try {
      context.log.info(
        logCtx(context, { ref, deployment: deployment.id }),
        "pr close: mark inactive"
      );
      await context.github.repos.createDeploymentStatus(
        withPreview({
          ...context.repo(),
          deployment_id: deployment.id,
          state: "inactive"
        })
      );
    } catch (error) {
      context.log.error(
        logCtx(context, { error, ref, deployment: deployment.id }),
        "pr close: marking inactive failed"
      );
    }
    environments[deployment.environment] = deployment;
  }

  context.log.info(
    logCtx(context, { ref, environments: Object.keys(environments).map(e => e) }),
    "pr close: remove deploys"
  );
  for (const env in environments) {
    const deployment = environments[env];
    try {
      context.log.info(
        logCtx(context, { ref, deployment: deployment.id }),
        "pr close: remove deploy"
      );
      // Undeploy for every unique environment by copying the deployment params
      // and triggering a deployment with the task "remove".
      await context.github.repos.createDeployment(
        context.repo({
          ref: sha,
          task: "remove",
          required_contexts: [],
          payload: deployment.payload as any,
          environment: deployment.environment,
          description: deployment.description || "",
          transient_environment: deployment.transient_environment,
          production_environment: deployment.production_environment
        })
      );
    } catch (error) {
      context.log.error(
        logCtx(context, { error, ref, deployment: deployment.id }),
        "pr close: failed to undeploy"
      );
    }
  }
}

export function commands(app: Application) {
  app.on("push", async context => {
    await handleAutoDeploy(context);
  });
  app.on("status", async context => {
    await handleAutoDeploy(context);
  });
  app.on("check_run", async context => {
    await handleAutoDeploy(context);
  });
  app.on("issue_comment.created", async context => {
    if (context.payload.comment.body.startsWith("/deploy")) {
      await handlePRDeploy(context, context.payload.comment.body);
    }
  });
  app.on("pull_request.closed", async context => {
    await handlePRClose(context);
  });
}

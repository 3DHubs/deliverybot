import { AuthedRequest, setUser } from "./auth";
import { Response, Application } from "express";
import * as pkg from "../package";

export async function index(req: AuthedRequest, res: Response) {
  if (!req.user) {
    res.render("probot", { ...pkg, anonymous: true });
    return;
  }

  const repoList: Array<{ repo: string; owner: string }> = [];
  const installations = await req.user!.github.apps.listInstallationsForAuthenticatedUser(
    {}
  );
  for (const install of installations.data.installations) {
    const repos = await req.user!.github.apps.listInstallationReposForAuthenticatedUser(
      { installation_id: install.id }
    );
    for (const repo of repos.data.repositories) {
      repoList.push({ repo: repo.name, owner: repo.owner.login });
    }
  }

  res.render("home", { repos: repoList, pkg });
}

export function home(app: Application) {
  app.get("/", setUser, index);
}

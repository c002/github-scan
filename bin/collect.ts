#!/usr/bin/env npx ts-node
import * as debugAPI from 'debug';
import * as fs from 'fs';
import fetch from 'node-fetch';
import { Response } from 'node-fetch';
import * as path from 'path';

import { UserList, KeyList, IPair, IUser } from '../src/common';

const debug = debugAPI('github-scan');

const GITHUB_API = 'https://api.github.com';
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;

const KEYS_DIR = path.join(__dirname, '..', 'keys');
const LAST_INDEX_FILE = path.join(KEYS_DIR, 'last-index.json');
const USER_FILE = path.join(KEYS_DIR, 'users.json');

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function githubRequest<T>(path: string, query: string = '')
    : Promise<[T, false | string]> {
  let url = `${GITHUB_API}${path}`;
  if (GITHUB_CLIENT_ID) {
    url += `?client_id=${GITHUB_CLIENT_ID}`;
    url += `&client_secret=${GITHUB_CLIENT_SECRET}`;
    if (query) {
      url += `&${query}`;
    }
  } else if (query) {
    url += `?${query}`;
  }

  debug(`request ${path}?${query}`);

  let res: Response;
  for (;;) {
    try {
      res = await fetch(url);
    } catch (e) {
      debug(e.message);
      debug(`retrying ${url} in 5 secs`);
      await delay(5000);
      continue;
    }
    break;
  }

  // Rate-limiting
  if (res.status === 403) {
    const remaining = parseInt(res.headers.get('x-ratelimit-remaining')!, 10);
    if (remaining > 0) {
      debug(`403, but still have ${remaining} reqs left`);
      debug('Retrying in 5 secs');
      await delay(5000);
      return await githubRequest(path, query);
    }

    const resetAt = parseInt(res.headers.get('x-ratelimit-reset')!, 10) * 1000;
    debug(`rate limited until: ${new Date(resetAt)}`);

    const timeout = Math.max(0, resetAt - Date.now());
    debug(`retrying ${path}?${query} in ${(timeout / 1000) | 0} secs`);

    // Add extra seconds to prevent immediate exhaustion
    await delay(timeout + 10000);

    return await githubRequest(path, query);
  }

  if (res.status !== 200) {
    debug(`Unexpected error code: ${res.status}`);
    debug('Retrying in 5 secs');
    await delay(5000);
    return await githubRequest(path, query);
  }

  const link = res.headers.get('link');
  let next: boolean | string = false;
  if (link) {
    // Link: <...>; rel="next"
    const match = link.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (match) {
      next = match[1];
    }
  }

  return [ await res.json(), next ];
}

async function* githubUsers(): AsyncIterableIterator<UserList> {
  let lastId = 0;

  try {
    const rawIndex = await fs.promises.readFile(LAST_INDEX_FILE)
    lastId = parseInt(rawIndex.toString(), 10);
  } catch (e) {
    debug('No index file, using 0');
  }

  for (;;) {
    const [ list, next ] =
        await githubRequest<UserList>('/users', `since=${lastId}`);
    await fs.promises.writeFile(LAST_INDEX_FILE, lastId.toString());

    if (!next) {
      throw new Error('Expected next page link!');
    }

    const match = next.match(/\/users\?(?:.*)since=(\d+)/);
    if (!match) {
      throw new Error(`Invalid link header: ${next}`);
    }

    lastId = parseInt(match[1]);

    yield list;
  }
}

async function githubKeys(user: IUser) {
  const [ keys, _ ] = await githubRequest<KeyList>(`/users/${user.login}/keys`);
  return keys;
}

async function* fetchAll(): AsyncIterableIterator<IPair> {
  for await (const userPage of githubUsers()) {
    const pairs = await Promise.all(userPage.map(async (user) => {
      const keys = await githubKeys(user);

      return { user, keys };
    }));

    for (const pair of pairs) {
      yield pair;
    }
  }
}

async function main() {
  const out = fs.createWriteStream(USER_FILE, { flags: 'a+' });
  for await (const pair of fetchAll()) {
    const fileName = path.join(KEYS_DIR, pair.user.login + '.json');
    out.write('\n' + JSON.stringify(pair));
  }
}

main().catch((e) => {
  console.log(e);
});
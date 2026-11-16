'use strict';

// Loaded only from the trusted base branch. Never check out or execute PR code.
module.exports = async function ({github, context, core}) {
  const repo = {owner: 'Manhattanca', repo: 'RimWise-Marketplace'};
  if (context.repo.owner !== repo.owner || context.repo.repo !== repo.repo) throw Error('Wrong repository');
  const number = Number(context.payload.pull_request?.number ?? context.payload.inputs?.pull_number);
  if (!Number.isSafeInteger(number) || number <= 0) throw Error('Invalid pull number');
  const get = async () => (await github.rest.pulls.get({...repo, pull_number: number})).data;
  const pull = await get();
  core.setOutput('merged', 'false');
  if (pull.state !== 'open' || pull.draft || pull.base.ref !== 'main' || pull.base.repo.full_name !== `${repo.owner}/${repo.repo}`) return;
  const files = await github.paginate(github.rest.pulls.listFiles, {...repo, pull_number: number, per_page: 100});
  // Publications always require manual moderation. Mixed changes never auto-merge.
  if (!files.length || files.some(file => file.status !== 'removed')) return;
  if (files.length > 400) throw Error('Removal too large for automatic processing');
  const manifestPattern = /^marketplace\/manifests\/([a-z0-9-]+)\/([a-z0-9][a-z0-9-]{0,63})\/(?:[a-z0-9.-]+)\.json$/;
  const manifests = files.filter(file => manifestPattern.test(file.filename));
  if (!manifests.length) throw Error('Removal has no manifests');
  const [, author, id] = manifests[0].filename.match(manifestPattern);
  if (author !== pull.user.login.toLowerCase() || !Number.isSafeInteger(pull.user.id)) throw Error('Not the original author');
  const prefix = `marketplace/manifests/${author}/${id}/`;
  if (manifests.some(file => !file.filename.startsWith(prefix))) throw Error('Removal must cover one order');
  const tree = (await github.rest.git.getTree({...repo, tree_sha: pull.base.sha, recursive: '1'})).data;
  if (tree.truncated) throw Error('Incomplete trusted tree');
  const expected = new Set(tree.tree.filter(item => item.path.startsWith(prefix) && item.type === 'blob').map(item => item.path));
  if (expected.size !== manifests.length || manifests.some(file => !expected.has(file.filename))) throw Error('Remove all versions together');
  for (const file of manifests) {
    const data = (await github.rest.repos.getContent({...repo, path: file.filename, ref: pull.base.sha})).data;
    if (data.type !== 'file' || data.encoding !== 'base64' || data.size > 2000000) throw Error('Invalid trusted manifest');
    const manifest = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
    if (manifest.author.toLowerCase() !== author || manifest.id !== id) throw Error('Author metadata mismatch');
    if (`${prefix}${manifest.version}.json` !== file.filename) throw Error('Version metadata mismatch');
    for (const image of manifest.images ?? []) {
      if (!image.path.startsWith(`marketplace/images/${author}/${id}/${manifest.version}/`) || image.path.includes('..') || image.path.includes('\\')) throw Error('Image ownership mismatch');
      expected.add(image.path);
    }
    // Use GitHub's immutable account ID from the merged publication, never the
    // PR body, JSON author label, commit email or current login alone.
    const commits = (await github.rest.repos.listCommits({...repo, path: file.filename, sha: pull.base.sha, per_page: 100})).data;
    let publication;
    for (const commit of commits) {
      const related = await github.paginate(github.rest.repos.listPullRequestsAssociatedWithCommit, {...repo, commit_sha: commit.sha, per_page: 100});
      for (const original of related) {
        if (!original.merged_at || original.base.ref !== 'main' || original.base.repo.full_name !== `${repo.owner}/${repo.repo}`) continue;
        const changes = await github.paginate(github.rest.pulls.listFiles, {...repo, pull_number: original.number, per_page: 100});
        if (changes.some(change => change.filename === file.filename && change.status === 'added')) {
          if (publication && publication !== original.user.id) throw Error('Ambiguous original publisher');
          publication = original.user.id;
        }
      }
    }
    if (publication !== pull.user.id) throw Error('Original publisher identity was not proven');
  }
  if (expected.size !== files.length || files.some(file => !expected.has(file.filename))) throw Error('Unexpected removal paths');
  const latest = await get();
  if (latest.state !== 'open' || latest.draft || latest.head.sha !== pull.head.sha || latest.base.sha !== pull.base.sha || latest.user.id !== pull.user.id) throw Error('Pull changed during verification');
  const result = await github.rest.pulls.merge({...repo, pull_number: number, sha: pull.head.sha, merge_method: 'squash', commit_title: `作者本人下架排序 #${number}`});
  if (!result.data.merged) throw Error('GitHub did not confirm merge');
  core.setOutput('merged', 'true');
  core.info(`Verified original publisher and removed order in PR #${number}.`);
};

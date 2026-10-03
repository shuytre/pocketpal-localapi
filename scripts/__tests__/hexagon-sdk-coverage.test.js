const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const ACTION = path.join(
  ROOT,
  '.github',
  'actions',
  'setup-hexagon-sdk',
  'action.yml',
);
const LLAMA_RN_CMAKE = [
  path.join(
    ROOT,
    'node_modules/llama.rn/android/src/main/rnllama/CMakeLists.txt',
  ),
  path.join(ROOT, 'node_modules/llama.rn/android/src/main/CMakeLists.txt'),
];

/**
 * The provisioning action verifies a digest over a narrow subset of the ~3 GB
 * SDK — the parts the Android build reads or links. That subset is only sound
 * while it still covers what llama.rn's CMake actually references. A widened
 * include set would otherwise leave the digest green over a stale, narrower
 * set, and on a cache hit the tarball digest is not there to catch it.
 *
 * Paths llama.rn references that this repackaging does not ship. A compiler
 * ignores a missing include directory, so nothing is consumed from them.
 */
const NOT_SHIPPED = {
  'utils/examples': 'absent from the snapdragon-toolchain repackaging',
};

const cmakeSources = LLAMA_RN_CMAKE.map(file =>
  fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '',
).join('\n');

const referenced = [
  ...new Set(
    [...cmakeSources.matchAll(/\$\{HEXAGON_SDK_ROOT\}\/([^\s")]+)/g)].map(
      match => match[1],
    ),
  ),
].sort();

const actionExists = fs.existsSync(ACTION);

const consumedPaths = (() => {
  if (!actionExists) {
    return null;
  }
  const match = fs
    .readFileSync(ACTION, 'utf-8')
    .match(/^\s*CONSUMED_PATHS="([^"]*)"/m);
  return match ? match[1].trim().split(/\s+/).filter(Boolean) : null;
})();

// 这个测试守护的是 .github/actions/setup-hexagon-sdk —— 一个把~3 GB
// Snapdragon SDK 重打包、并对其中被构建实际读取的子集做 digest 的 action。
// 本 fork 没有 vendored 这个 action：.github/ 下只有 workflows/，且
// build.yml 完全没有引用它（构建直接用预编译的 llama.rn，不自建 SDK）。
// 所以这里没有可比对的两侧，action 若将来被引入，这些断言会自动恢复生效。
const describeIfAction = actionExists ? describe : describe.skip;

if (!actionExists) {
  // eslint-disable-next-line no-console
  console.warn(
    `[hexagon-sdk-coverage] 跳过：${path.relative(
      ROOT,
      ACTION,
    )} 不存在，本 fork 未引入该 action`,
  );
}

describeIfAction('the parse itself', () => {
  // Without these, a rename on either side makes every assertion below pass
  // over an empty set.
  it('finds the SDK paths llama.rn references', () => {
    expect(referenced.length).toBe(5);
  });

  it('finds the paths the provisioning action digests', () => {
    expect(consumedPaths).not.toBeNull();
    expect(consumedPaths.length).toBeGreaterThan(0);
  });
});

describeIfAction('the verified subset covers what the build consumes', () => {
  const covers = (consumed, ref) =>
    ref === consumed || ref.startsWith(`${consumed}/`);

  it.each(referenced)('%s', ref => {
    if (NOT_SHIPPED[ref]) {
      return;
    }
    expect(consumedPaths.some(consumed => covers(consumed, ref))).toBe(true);
  });

  it('digests nothing that llama.rn does not reference', () => {
    const unreferenced = consumedPaths.filter(
      consumed => !referenced.some(ref => covers(consumed, ref)),
    );
    expect(unreferenced).toEqual([]);
  });

  it('states why each referenced path it skips is not shipped', () => {
    const skipped = referenced.filter(
      ref => !consumedPaths.some(consumed => covers(consumed, ref)),
    );
    expect(skipped).toEqual(Object.keys(NOT_SHIPPED));
  });
});

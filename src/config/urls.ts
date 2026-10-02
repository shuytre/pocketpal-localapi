import {FIREBASE_FUNCTIONS_URL} from '@env';

/**
 * TwinCore：模型仓库改走国内镜像站（hf-mirror.com）。
 *
 * 原值 `https://huggingface.co` 在国内直连经常超时 / 被墙，用户明确要求
 * 「不能从国外的模型网站，要从国内镜像站访问」。
 *
 * hf-mirror.com 是 HuggingFace 的完整反向代理镜像：
 *   - 网页与 API 路径结构完全一致（/api/models、/{repo}/resolve/main/{file}）
 *   - 支持同样的 model 列表 / tree / resolve 三类端点，因此只需替换域名，
 *     urls.ts 下游所有函数（modelsList / modelTree / modelDownloadFile ...）
 *     与 src/api/hf.ts、ModelStore 的下载逻辑都无需改动。
 *
 * 注意：镜像站不保证 100% 覆盖所有模型与 commit，个别冷门仓库可能 404；
 * 若后续需要，可在设置里提供「镜像 / 官方」切换，这里先锁死镜像以满足需求。
 */
export const HF_DOMAIN = 'https://hf-mirror.com';
export const HF_API_BASE = `${HF_DOMAIN}/api/models`;

// Fallback for Firebase Functions URL if not configured
const FIREBASE_BASE =
  FIREBASE_FUNCTIONS_URL || 'https://placeholder-firebase-functions.com';

export const urls = {
  // API URLs
  modelsList: () => `${HF_API_BASE}`,
  modelTree: (modelId: string) => `${HF_API_BASE}/${modelId}/tree/main`,
  modelSpecs: (modelId: string) => `${HF_API_BASE}/${modelId}`,

  // Web URLs
  modelDownloadFile: (modelId: string, filename: string) =>
    `${HF_DOMAIN}/${modelId}/resolve/main/${filename}`,
  modelWebPage: (modelId: string) => `${HF_DOMAIN}/${modelId}`,

  // Benchmark Endpoint
  benchmarkSubmit: () => `${FIREBASE_BASE}/api/v1/submit`,

  // Feedback Endpoint
  feedbackSubmit: () => `${FIREBASE_BASE}/feedback`,
};

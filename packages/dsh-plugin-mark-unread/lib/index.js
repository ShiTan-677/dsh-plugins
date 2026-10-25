/**
 * Node half：本插件没有任何宿主侧行为。
 *
 * 未读标记是纯浏览器状态（localStorage），不消费宿主服务、不写宿主存储；
 * 这里只满足官方 bundle 插件契约（name / inject / apply），
 * 让 profile 能挂载这一行 entry，并让 client 内核据 dsh.client 组合浏览器 half。
 *
 * @see ./../README.md 「实现」一节
 */

export const name = 'dsh-plugin-mark-unread'

/** 不依赖任何宿主服务。 */
export const inject = []

export function apply() {
  // 无宿主侧行为。
}

/**
 * hide-version-pill — 隐藏状态栏右下角的版本号/update 提示
 *
 * Hermes 状态栏的 version-client 条目写死了 lockedVisible: true,
 * 右键菜单里无法关闭。本插件通过 MutationObserver 在 DOM 层隐藏它。
 * 需要更新时去 Settings → About 手动检查。
 */

// 版本号标签的文本特征：v0.20.2 / v0.20.2 · update / backend v0.20.2 等
const VERSION_RE = /v\d+\.\d+/i

const STYLE_ID = 'hide-version-pill-style'
const HIDDEN_FLAG = 'data-version-pill-hidden'

const HIDE_CSS = `
  [data-slot="statusbar"] button[data-version-pill-hidden] {
    display: none !important;
  }
`

/**
 * 在状态栏里找到版本号按钮并标记隐藏。
 * 版本号按钮的特征：含有 SVG 图标 + 文本匹配 v\d+\.\d+
 */
function hideVersionPills() {
  const bar = document.querySelector('[data-slot="statusbar"]')
  if (!bar) return

  const buttons = bar.querySelectorAll('button')
  for (const btn of buttons) {
    if (btn.hasAttribute(HIDDEN_FLAG)) continue

    const text = btn.textContent || ''
    if (VERSION_RE.test(text)) {
      btn.setAttribute(HIDDEN_FLAG, '')
    }
  }
}

/**
 * 清理：移除所有隐藏标记（插件热重载/卸载时恢复）
 */
function unhideAll() {
  document.querySelectorAll(`[${HIDDEN_FLAG}]`).forEach(el => {
    el.removeAttribute(HIDDEN_FLAG)
  })
}

export default {
  id: 'hide-version-pill',
  name: 'Hide Version Pill',
  defaultEnabled: true,

  register(ctx) {
    // 注入 CSS
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = HIDE_CSS
      document.head.appendChild(style)
    }

    // 立即尝试 + MutationObserver 持续监控
    hideVersionPills()

    const observer = new MutationObserver(() => hideVersionPills())
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })

    // 也监听状态栏本身的出现（应用启动早期可能还没渲染）
    const bodyObserver = new MutationObserver(() => {
      const bar = document.querySelector('[data-slot="statusbar"]')
      if (bar) {
        hideVersionPills()
      }
    })
    bodyObserver.observe(document.body, { childList: true, subtree: true })

    // 返回 disposer，插件卸载时调用
    return () => {
      observer.disconnect()
      bodyObserver.disconnect()
      unhideAll()
      const style = document.getElementById(STYLE_ID)
      if (style) style.remove()
    }
  }
}

import { useEffect } from 'react'
import { Navigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../contexts/auth'
import { AuthLayout } from '../features/auth/AuthLayout'
import { LoginForm } from '../features/auth/LoginForm'
import { needsDocumentLoad } from '../lib/next-navigation'
import { safeNext } from '../lib/safe-next'

/**
 * 登录页。**只做一件事**：已经登录的人不该再看见它。
 * 表单本体在 `features/auth/`（project-structure.md「路由文件只做布局和数据编排」）。
 *
 * 已登录时也认 `next`（2026-10-31 加，MCP OAuth 任务）：授权流程会把未登录的人送到
 * `/login?next=/oauth/authorize?<原查询串>`，在**另一个标签页**先登好的人再打开这个链接时
 * 走的就是这一条。判据与登录成功那次是同一个 `safeNext`，不另写一份。
 *
 * ## 为什么这里也要分「整页 / 软跳」
 *
 * `<Navigate>` 与 `navigate()` 是同一种软跳。`next` 指向 `/oauth/authorize` 时，它同样
 * 只会换 URL、不发请求——服务端没被叫醒，ticket 也就不会签。分流判据必须与
 * `LoginForm` 用的**同一个**（`lib/next-navigation.ts`），两边各判各的迟早分叉：
 * 表单那条修好了、已登录这条仍是死的，而这种分支在自动化里很难被看见。
 *
 * 整页分支只写了 effect，`<Navigate>` 留在另一边——两者互斥，不会都执行。
 */
export function LoginPage() {
  const { user } = useAuth()
  const [searchParams] = useSearchParams()
  const target = safeNext(searchParams.get('next'))
  const documentLoad = needsDocumentLoad(target)

  useEffect(() => {
    if (user && documentLoad) window.location.replace(target)
  }, [user, documentLoad, target])

  if (user) {
    if (documentLoad) return null
    return <Navigate to={target} replace />
  }

  return (
    <AuthLayout>
      <LoginForm />
    </AuthLayout>
  )
}

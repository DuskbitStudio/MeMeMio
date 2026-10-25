import { useEffect, useState } from 'react'
import { ApiError, fetchAdminUsers, patchAdminUser, type AdminUser } from '../../lib/api'
import { formatBytes, formatDate } from '../../lib/format'
import { cn } from '../../lib/utils'
import { useAuth } from '../../contexts/auth'
import { Alert, AlertTitle } from '../../components/ui/alert'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table'
import { SettingsCard } from './SettingsCard'
import { TOUCH } from './settings-ui'

/**
 * 设置页 · 用户（仅管理员可见的分段，原 `/admin/users` 整页）。
 *
 * 和 [InviteSettings] 一样，加载态在卡片内部 —— 切到 `#users` 这一段时标题要立刻在。
 */

type RowState = {
  role: 'admin' | 'member'
  quotaInput: string
  saving: boolean
  error: string | null
  /**
   * 「这一行的这次保存成了」（2026-09-24 补）。此前成功**没有任何提示**——
   * 表格刷一下、按钮从「保存中…」变回「保存」，与什么都没发生长得一样。
   *
   * 走行内不走 toast：同页另外三张卡（`EmbedSettings` / `VisionSettings` /
   * `RuntimeSettings`）的保存确认都是行内 `role="status"`，这一页的**失败**侧本来
   * 也已经是行内 `role="alert"`——成功侧改成 toast 会让同一行有两个渠道。
   * 这也正是 `http.md §5` 那条「设置页不弹 toast」的口径（用户 2026-09-24 裁定保持）。
   */
  saved: boolean
}

export function UsersSettings() {
  const { user: currentUser } = useAuth()
  const [users, setUsers] = useState<AdminUser[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [requestId, setRequestId] = useState<string | null>(null)
  const [rows, setRows] = useState<Record<string, RowState>>({})

  useEffect(() => {
    fetchAdminUsers()
      .then((data) => {
        setUsers(data)
        const initial: Record<string, RowState> = {}
        for (const u of data) {
          initial[u.id] = {
            role: u.role,
            quotaInput: String(u.storageQuotaBytes),
            saving: false,
            error: null,
            saved: false,
          }
        }
        setRows(initial)
      })
      .catch((err) => {
        if (err instanceof ApiError) {
          setError(err.message)
          setRequestId(err.requestId)
        } else {
          setError('加载失败')
        }
      })
      .finally(() => setLoading(false))
  }, [])

  function setRow(id: string, patch: Partial<RowState>) {
    setRows((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } as RowState }))
  }

  async function handleSave(userId: string) {
    const row = rows[userId]
    if (!row) return
    const quota = parseInt(row.quotaInput, 10)
    if (isNaN(quota) || quota < 0) {
      // 本地这一关没过就没有「已保存」可言，但**也不能把上一次的收掉**——
      // 上一次确实存成了，收掉它等于改写了已经发生过的事
      setRow(userId, { error: '配额必须是非负整数' })
      return
    }
    setRow(userId, { saving: true, error: null, saved: false })
    try {
      const updated = await patchAdminUser(userId, { role: row.role, storageQuotaBytes: quota })
      setUsers((prev) =>
        prev.map((u) =>
          u.id === userId ? { ...u, role: updated.role, storageQuotaBytes: updated.storageQuotaBytes } : u,
        ),
      )
      setRow(userId, { saving: false, saved: true })
    } catch (err) {
      if (err instanceof ApiError) {
        setRow(userId, {
          saving: false,
          saved: false,
          error: `${err.message}（requestId：${err.requestId}）`,
        })
      } else {
        setRow(userId, { saving: false, saved: false, error: '保存失败' })
      }
    }
  }

  return (
    <SettingsCard
      title="用户"
      description="角色决定权限，存储配额决定这个账号能占用多少空间。"
      action={!loading && !error && <Badge variant="secondary">{users.length} 人</Badge>}
    >
      {loading && <p className="text-sm text-muted-foreground">加载中…</p>}
      {error && (
        <Alert variant="destructive">
          <AlertTitle>
            {error}
            {requestId && `（requestId：${requestId}）`}
          </AlertTitle>
        </Alert>
      )}

      {!loading && !error && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ID</TableHead>
              <TableHead>用户名</TableHead>
              <TableHead>角色</TableHead>
              <TableHead>存储配额</TableHead>
              <TableHead>已用空间</TableHead>
              <TableHead>注册时间</TableHead>
              <TableHead>操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((u) => {
              const row = rows[u.id]
              const isSelf = u.id === currentUser?.id
              const willLoseSelf = isSelf && row?.role === 'member'
              return (
                <TableRow key={u.id}>
                  <TableCell className="font-mono text-xs">{u.id}</TableCell>
                  <TableCell>{u.name}</TableCell>
                  <TableCell>
                    <Select
                      value={row?.role ?? u.role}
                      disabled={row?.saving}
                      // 改过之后那一行的「已保存」不再代表现在这一格里的值，收掉它
                      // （与 `RuntimeSettings.setField` 同一条：留着一句已经不成立的话
                      // 比没有提示更坏）
                      onValueChange={(value) =>
                        setRow(u.id, { role: value as 'admin' | 'member', saved: false })
                      }
                    >
                      <SelectTrigger
                        size="sm"
                        className={cn(TOUCH, 'w-30')}
                        aria-label={`${u.name} 的角色`}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="admin" className={TOUCH}>
                          admin
                        </SelectItem>
                        <SelectItem value="member" className={TOUCH}>
                          member
                        </SelectItem>
                      </SelectContent>
                    </Select>
                    {willLoseSelf && (
                      <p className="mt-1 text-xs text-destructive">降为 member 后将失去管理权限</p>
                    )}
                  </TableCell>
                  <TableCell>
                    <Input
                      type="number"
                      aria-label={`${u.name} 的存储配额（字节）`}
                      min={0}
                      value={row?.quotaInput ?? String(u.storageQuotaBytes)}
                      onChange={(e) => setRow(u.id, { quotaInput: e.target.value, saved: false })}
                      className={cn(TOUCH, 'w-32')}
                    />
                  </TableCell>
                  <TableCell>{formatBytes(u.storageUsedBytes)}</TableCell>
                  <TableCell>{formatDate(u.createdAt)}</TableCell>
                  <TableCell>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className={TOUCH}
                      disabled={row?.saving}
                      onClick={() => handleSave(u.id)}
                    >
                      {row?.saving ? '保存中…' : '保存'}
                    </Button>
                    {/*
                      行内的错误用一行小字，不用 Alert：那颗组件是 `px-4 py-3` 的整块，
                      塞进单元格会把行撑成一张卡，而这里要说清的只有一句话。
                      role="alert" 保留——保存失败必须被读屏念出来。
                    */}
                    {row?.error && (
                      <p role="alert" className="mt-1 text-xs text-destructive">
                        {row.error}
                      </p>
                    )}
                    {/* 成功侧与失败侧同一个位置、同一行小字，只是不带红色：
                        同一格里的两个结果摆在同一个地方，眼睛不用找。
                        字号用 `text-xs` 而不是同页三张卡的 `text-sm`——那一列只有
                        一半宽度，`text-sm` 的「已保存」会把行撑得比上面的输入框还宽。 */}
                    {row?.saved && (
                      <p role="status" className="mt-1 text-xs text-muted-foreground">
                        已保存
                      </p>
                    )}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      )}
    </SettingsCard>
  )
}

/**
 * 审计详情抽屉里的一格：按 id 现查一张表情包（`GET /memes/{id}`，SPEC §10.8）。
 *
 * ## 为什么按 id 现查，而不是把返回时那份数据存下来
 *
 * 日志只记 id（任务 §2 第 7 条）：**日志不该变成第二份内容副本**。图后来改了描述、
 * 换了标签，抽屉里看到的就该是现在的样子；图被软删了就显示「已删除或不可见」——
 * 这一条是**信息**，不是错误，所以 404 有专门的态，不落进「加载失败」。
 *
 * ## 四个态
 *
 * `loading` / `ok` / `gone`（404）/ `error`（其余）。**不合并 `gone` 与 `error`**：
 * 前者重试没有意义（图确实没了），后者给重试按钮才有用。`code-style.md` 的三态要求
 * 在这里多一档，因为「404」不是「请求失败」，是「这一格要显示的内容」。
 *
 * ## 为什么不用 `MemeImage`
 *
 * 那个组件要 `Meme`（列表项，带 `matchedBy`），而 `GET /memes/{id}` 给的是 `MemeDetail`，
 * 两者不同形；它还会接到全屏阅览器上，而抽屉里点开一个嵌套的全屏层，关闭时焦点回不到
 * 原处。这里只渲染一张**不该被裁剪**的图：白底、`object-contain`、固定方框，
 * 与 `MemeImage` 的容器约定一致（styling.md「图片不裁剪」「深色底是白的」）。
 */

import { useEffect, useState } from 'react'
import { ImageOff } from 'lucide-react'
import { ApiError, fetchMeme, type MemeDetail } from '../../lib/api'
import { TOUCH } from '../../lib/touch'
import { VOCAB_DIMENSIONS } from '../../lib/vocab'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Shimmer } from '../../components/ui/shimmer'
import { AUDIT_COPY } from './audit-copy'

type CellState =
  | { status: 'loading' }
  | { status: 'ok'; meme: MemeDetail }
  | { status: 'gone' }
  | { status: 'error' }

/**
 * 要显示的标签值。**内容分级排最前**，其余按 `VOCAB_DIMENSIONS` 的顺序——
 * 与 `LightboxViewer` 的 `labelValues` 同一条口径（那一份能遍历就遍历，加维度时不会漏）。
 * 这里另写一份是因为那份不收 `MemeDetail`，而且抽屉只显示前几个，不显示全部。
 */
function labelValues(meme: MemeDetail): string[] {
  const described = VOCAB_DIMENSIONS.filter((d) => d.field !== 'ratings').flatMap(
    (d) => meme[d.field],
  )
  return [...meme.ratings, ...described]
}

/** 一格最多显示几个标签，其余并成 `+n`：格宽在 390 手机上约 110px。 */
const MAX_LABELS = 3

/**
 * 图片框。**始终白底**，和 `MemeImage` 同一条理由：表情包多是浅色背景，
 * 深色模式下让白底图贴着深色背景就分不出边界了。所以框里的字用固定 `zinc` 值，
 * 不用 `text-muted-foreground`（那个 token 在深色下是浅色，压在白底上会消失）。
 */
const FRAME = 'relative block aspect-square w-full overflow-hidden rounded-xl bg-white shadow-sm'

export function AuditResultCell({ memeId }: { memeId: string }) {
  const [state, setState] = useState<CellState>({ status: 'loading' })
  /** 重试就是把它 +1：effect 的重跑由它触发，不必再抄一份请求逻辑。 */
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })
    fetchMeme(memeId).then(
      (meme) => {
        if (!cancelled) setState({ status: 'ok', meme })
      },
      (err: unknown) => {
        if (cancelled) return
        // 404 单独一档：软删/不可见是这一格要展示的内容，不是加载失败
        setState(err instanceof ApiError && err.status === 404 ? { status: 'gone' } : { status: 'error' })
      },
    )
    return () => {
      cancelled = true
    }
  }, [memeId, attempt])

  if (state.status === 'loading') {
    return (
      <div className={FRAME}>
        <Shimmer appear={false} className="absolute inset-0 dark:via-white/60" />
      </div>
    )
  }

  if (state.status === 'gone') {
    return (
      <div className={FRAME}>
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 p-2 text-center">
          <ImageOff className="size-5 shrink-0 text-zinc-400" />
          <span className="text-xs text-zinc-500">{AUDIT_COPY.drawerCellGone}</span>
        </div>
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div className={FRAME}>
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 p-2 text-center">
          <span className="text-xs text-zinc-500">{AUDIT_COPY.errorTitle}</span>
          <Button variant="link" size="sm" className={TOUCH} onClick={() => setAttempt((n) => n + 1)}>
            重试
          </Button>
        </div>
      </div>
    )
  }

  const { meme } = state
  const label = meme.description ?? meme.originalFilename ?? meme.id
  const labels = labelValues(meme)
  const shown = labels.slice(0, MAX_LABELS)
  const rest = labels.length - shown.length

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className={FRAME}>
        <img
          src={meme.thumbUrl ?? meme.url}
          alt={label}
          loading="lazy"
          width={meme.width ?? undefined}
          height={meme.height ?? undefined}
          className="h-full w-full object-contain"
        />
      </div>
      {meme.description !== null && meme.description !== '' && (
        <p className="line-clamp-2 text-xs text-pretty">{meme.description}</p>
      )}
      {shown.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {shown.map((value) => (
            <Badge key={value} variant="outline" className="max-w-full truncate text-[11px]">
              {value}
            </Badge>
          ))}
          {rest > 0 && (
            <span className="text-[11px] text-muted-foreground tabular-nums">+{rest}</span>
          )}
        </div>
      )}
    </div>
  )
}

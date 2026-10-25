import { useRef, useState } from 'react'
import { Info } from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../components/ui/alert-dialog'
import { Alert, AlertDescription, AlertTitle } from '../../components/ui/alert'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Progress } from '../../components/ui/progress'
import { ApiError, fetchTagStatus, startRetag, type RetagResult, type TagStatusSummary } from '../../lib/api'
import { TOUCH } from '../../lib/touch'
import { SettingsCard } from './SettingsCard'
import { Tip } from './Tip'
import { pollProblemText, usePolledStatus } from './use-poll-status'

/**
 * 全库重新打标（SPEC §6.4.3）。
 *
 * **为什么需要它。** 打标的输入是「提示词 + 词表」，两者都会变——词表加了第七维
 * `ratings`、提示词跟着多问了一问。存量图不会自己更新，没有这个按钮就只能逐张
 * 人工 `PATCH`。「重建索引」不是替代品：它只重算 embedding，**不调视觉**（§6.5.4）。
 *
 * **它不是 `ReindexPanel` 的孪生兄弟**，三处差别都在钱上（§6.4.3）：不幂等、
 * 花的是**图片上传者**的视觉预算、跑完库里不留「这张被重打过」的痕迹。所以：
 *
 *   - 有确认框（`ReindexPanel` 没有），且「重复触发是安全的」那句话**不能复用**；
 *   - 进度没有服务端的分母，只能拿本次触发排上的条数当基线（见 `percent`）。
 */

type Props = {
  /** 父组件确认换模型后自增，用来立刻重拉一次（与 `ReindexPanel` 共用同一个信号）。 */
  refreshToken: number
}

/** 一格统计。与 `ReindexPanel` 里那个同形——两处都是「服务端算好的数，前端只显示」。 */
function Count({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-heading text-xl tabular-nums">{value}</dd>
    </div>
  )
}

/**
 * 点完那一句反馈。**三个计数要拼在一起看，不能只看 `enqueuedCount`。**
 *
 * `enqueuedCount` 为 0 有三种完全不同的成因，界面必须分辨——否则管理员只看到
 * 「0 条」，会以为按钮坏了然后反复点（`ReindexPanel` 的 `handleStart` 记着同一课）：
 *
 *   1. 这批图本来就都在队列里（刚点过一次）；
 *   2. 选中的图全被跳过了 → 由下面两个 `skipped*` 说明是**哪一种**跳过；
 *   3. 一张都没选中（库里是空的）。
 *
 * ⚠️ 第 2 种里的 `skippedUnconfiguredCount` **尤其不能吞**：那不是「干完了」，
 * 是「这些图重打不了，因为它们的上传者没配视觉通道」。服务端为这件事专门留了
 * 一个计数（SPEC §6.4.3），界面上不说出来就等于白做了。
 */
function retagNote(result: RetagResult): string {
  const skipped = result.skippedEditedCount + result.skippedUnconfiguredCount

  if (result.enqueuedCount > 0) {
    return skipped > 0
      ? `已排上 ${result.enqueuedCount} 张，另有 ${skipped} 张被跳过——${skipDetail(result)}。进度见下方。`
      : `已排上 ${result.enqueuedCount} 张，进度见下方。`
  }

  if (skipped > 0) return `没有新排队的——选中的图全被跳过了：${skipDetail(result)}。`
  return '没有新排队的——这批图已经都在队列里了，或者一张都没选中。'
}

/** 跳过的两种成因分开说，不合并成一个数：它们的出路完全不同。 */
function skipDetail(result: RetagResult): string {
  const parts: string[] = []
  if (result.skippedEditedCount > 0) {
    // 「跳过以免冲掉人补的标签」——不能写成「重打会冲掉人的工作」：
    // 那是**为什么跳过**，可它挤在一串跳过项里读起来像「已经冲掉了」。
    parts.push(`${result.skippedEditedCount} 张人工编辑过，跳过以免冲掉人补的标签`)
  }
  if (result.skippedUnconfiguredCount > 0) {
    parts.push(
      `${result.skippedUnconfiguredCount} 张的上传者没配视觉通道，重打不了（除非他先配上）`,
    )
  }
  return parts.join('；')
}

export function RetagPanel({ refreshToken }: Props) {
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [starting, setStarting] = useState(false)
  const [startNote, setStartNote] = useState<string | null>(null)
  const [startError, setStartError] = useState<string | null>(null)
  const [manualTick, setManualTick] = useState(0)
  /**
   * 本次触发排上的条数，**只在这一次点击之后有意义**。
   *
   * 它是进度条的分母。服务端给不出分母——`counts.pending` 是绝对值，其中还混着
   * 别人的图；而 retag 跑完不留任何痕迹，没有「这批是这次重打的」这种记录
   * （SPEC §6.4.3：进度不另做端点）。所以离开这一屏再回来就只剩计数、没有百分比，
   * 那是正常的，不是残缺。
   */
  const [baseline, setBaseline] = useState<number | null>(null)
  /** 确认框关掉后要把焦点交回这个按钮（没有 `AlertDialogTrigger`，Radix 找不到它）。 */
  const triggerRef = useRef<HTMLButtonElement>(null)
  /**
   * 按钮**被禁用**时焦点的去处。
   *
   * 确认之后队列就跑了，按钮随 `busy` 变成 `disabled`——而**禁用元素收不到焦点**，
   * `focus()` 是静默空操作，焦点掉回 `body`：屏幕阅读器用户被扔回页面顶端。
   * （实测：`focusBackOnButton` 为 false，而 `onCloseAutoFocus` 确实跑了。）
   * 所以那时退而求其次，交回按钮所在的那一行，用户的位置不变。
   */
  const rowRef = useRef<HTMLDivElement>(null)

  /**
   * 轮询（失败会退避重试，不会再一断就死在那儿）。
   *
   * 判据是 **`running` 不是 `pending`**：`pending` 会由「上传者没配通道」的图永远停着，
   * 用它会变成永不停的轮询（SPEC §6.4.3）。
   */
  const { status, problem } = usePolledStatus<TagStatusSummary>({
    load: () => fetchTagStatus('all'),
    isBusy: (next) => next.running > 0,
    fallbackMessage: '打标状态读取失败',
    restartKey: `${refreshToken}:${manualTick}`,
  })

  async function handleConfirm() {
    setStartError(null)
    setStartNote(null)
    setStarting(true)
    try {
      // `filter: {}` = 全库。非 admin 传它会被服务端收窄到自己，但这一段只有 admin 看得到
      const result = await startRetag({ filter: {} })
      setStartNote(retagNote(result))
      // 0 条时不设基线：没有分母就没有进度条，硬设一个会让进度条除出 NaN
      setBaseline(result.enqueuedCount > 0 ? result.enqueuedCount : null)
      setManualTick((n) => n + 1)
    } catch (err) {
      setStartError(
        err instanceof ApiError ? `${err.message}（requestId：${err.requestId}）` : '触发失败',
      )
    } finally {
      setStarting(false)
    }
  }

  /**
   * 队列正在跑 → 禁用。
   *
   * ⚠️ **判据只能是 `running`，不能是 `pending`**（SPEC §6.4.3）：`pending` 会由
   * 别人的上传造成，更会由「上传者没配视觉通道」的图**永远**停在那个状态，
   * 拿它当闸门就是永久禁用——一个比误点更坏的失败，因为它不报错、也没有出路。
   *
   * `running` 的代价是**两个 worker 恰好都在两次认领之间时会闪一下**（`queue/worker.ts`
   * 是 `CONCURRENCY = 2`，轮询间隔 5 秒），那一瞬间按钮是可点的。这不是靠再加状态
   * 能补的，兜底的始终是确认框——它会说清楚这一下要花上传者的钱。
   */
  const busy = starting || (status?.running ?? 0) > 0

  /**
   * 进度百分比。`baseline` 为 null（没在这一屏点过）时不算，界面只给计数。
   * 夹到 `[0, 100]`：`counts.pending` 含别人的图，可能比基线还大，不夹会出负数。
   */
  const done =
    baseline === null || status === null
      ? null
      : Math.max(0, Math.min(baseline, baseline - status.counts.pending))
  const percent = done !== null && baseline ? Math.round((done / baseline) * 100) : 0

  return (
    <SettingsCard
      title="重新打标"
      description="按当前的提示词与词表把库里的图重打一遍。改过词表或提示词之后，存量图不会自己更新，要靠这里。"
      action={
        status && (
          <Badge variant={busy ? 'default' : 'secondary'}>{busy ? '进行中' : '空闲'}</Badge>
        )
      }
    >
      {problem !== null && (
        // 中性提示不是错误：连不上服务端不是用户做错了什么，而且它在自己重试
        // （同 `ImportProgress` 的重连提示）
        <Alert role="status">
          <Info />
          <AlertDescription>
            {pollProblemText(problem)}
            {problem.requestId !== undefined && (
              <span className="mt-1 block font-mono text-xs">
                requestId：{problem.requestId}
              </span>
            )}
          </AlertDescription>
        </Alert>
      )}

      {status && (
        <div className="flex flex-col gap-4">
          {baseline !== null && (
            <div className="flex flex-col gap-2">
              <Progress value={percent} aria-label="重打标进度" />
              <p className="text-sm text-muted-foreground">
                本次排上 {baseline} 张，已完成 {percent}%。打标期间这些图显示为「待处理」，
                完成后自动更新，不影响搜索和其他操作。
              </p>
            </div>
          )}

          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Count label="已完成" value={String(status.counts.ok)} />
            <Count label="待处理" value={String(status.counts.pending)} />
            <Count label="需人工" value={String(status.counts.needsManual)} />
          </dl>
        </div>
      )}

      <div ref={rowRef} tabIndex={-1} className="flex flex-wrap gap-2 outline-none">
        <Button
          ref={triggerRef}
          type="button"
          variant="outline"
          className={TOUCH}
          disabled={busy}
          onClick={() => {
            setStartNote(null)
            setStartError(null)
            setConfirmOpen(true)
          }}
        >
          {busy ? '队列在跑，稍后再试' : '全部重新打标'}
        </Button>
      </div>
      {/*
        与 ReindexPanel 那句「重复触发是安全的」**刻意相反**（SPEC §6.4.3）：
        那个接口幂等且免费，这个不幂等且花图片上传者的钱。这里如果也写一句安抚的话，
        就成了误导。
      */}
      <Tip
        tone="warning"
        title={
          <>
            这一步会调用视觉模型重新打标，花的是<strong>图片上传者</strong>的配置和额度。
            人工编辑过的图不会被覆盖。
          </>
        }
      />

      {startNote && (
        <p role="status" className="text-sm">
          {startNote}
        </p>
      )}

      {startError && (
        <Alert variant="destructive">
          <AlertTitle>{startError}</AlertTitle>
        </Alert>
      )}

      {/*
        确认框。这一步花钱且覆盖标签，`ReindexPanel` 那种「点了就跑」不合适（§6.4.3）。
        形状照 `EmbedSettings` 那个：**受控 open/onOpenChange，不用 AlertDialogTrigger**。
        没有 trigger 的代价是 Radix 关框时找不到它（`triggerRef.current?.focus()` 里是 null）、
        焦点会掉在 body 上，所以要显式交回（同 `MemeActions` 的那条注释）。
      */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent
          onCloseAutoFocus={() => {
            // 没有 AlertDialogTrigger，Radix 自己那句 `triggerRef.current?.focus()` 里是 null，
            // 什么都不会做（同 `MemeActions` 的那条注释），所以这里显式交回。
            const btn = triggerRef.current
            if (btn && !btn.disabled) btn.focus()
            else rowRef.current?.focus()
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>把全库按当前提示词重打一遍？</AlertDialogTitle>
            <AlertDialogDescription>
              {/* 冒号写成表达式：跟在一段标签后面换行写，读数时很难确认它有没有被并进上一行 */}
              {'会调用视觉模型把'}
              <strong>库里的每一张图</strong>
              {'重新打一遍标，花的是图片上传者的配置和额度。'}
              <br />
              全库跑完大约十几分钟。期间搜索和其他操作都不受影响。
              <br />
              <strong>重打可能让一部分图变成「需人工」——它们的旧标签不会丢</strong>
              ，那是一个可以继续用的回退值。人工编辑过的图会被跳过，所以也不会因此获得新增的那一维。
              <br />
              {/* 不幂等，这句话必须在（§6.4.3）。「重复触发是安全的」是 reindex 的，别抄 */}
              这一下不是幂等的：再点一次会把跑完的图再送一遍、再花一遍钱。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            {/* 默认焦点落在「取消」上（AlertDialogContent 自带 onOpenAutoFocus）：
                花掉的预算收不回来，一次误触的回车不该把它付出去。 */}
            <AlertDialogCancel className={TOUCH}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={starting}
              className={TOUCH}
              // AlertDialogAction 本身是 DialogPrimitive.Close，点了会关。这里不等请求
              // 回来是有意的：请求只是入队、很快，失败原因显示在上面的卡里，
              // 不让用户对着一个框关不掉地找原因（EmbedSettings 同款取舍）。
              onClick={() => void handleConfirm()}
            >
              {starting ? '提交中…' : '确认重打'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsCard>
  )
}

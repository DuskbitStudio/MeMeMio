import { useEffect, useState } from 'react'
import { ApiError } from '../../lib/api'
import {
  fetchRuntimeConfig,
  putRuntimeConfig,
  type RuntimeConfig,
  type RuntimeInput,
} from '../../lib/api-config'
import { formatDate } from '../../lib/format'
import { cn } from '../../lib/utils'
import { Alert, AlertTitle } from '../../components/ui/alert'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { SettingsCard } from './SettingsCard'
import { ContractTip } from './Tip'
import { describeSaveError } from './save-error'
import { RUNTIME_NOTICE } from './settings-copy'
import { TOUCH } from './settings-ui'

/**
 * 设置页 · 运行参数（仅管理员，SPEC §5.6 / §6.5.5 / §9.26）。
 *
 * 四个并发上限从模块级常量搬到了库里的一张单行表：它们是**机器规格相关**的数，
 * 一台 2 核小机器和一台 16 核机器需要不同的值，而原来的写法是「改一次要改代码 + 重新部署」。
 *
 * ## 三处与相邻卡片不同、且都不能顺手统一的地方
 *
 * 1. **不套 `use-config-form.ts`。** 那个 hook 是「必须先测连接才能保存」那套状态机
 *    （视觉通道与 Embedding 共用），而纯数字配置没有测试环节——套上去只会多出一个
 *    永远为真的 `tested`。
 * 2. **不做前端 clamp，越界原样展示服务端的 `VALIDATION_FAILED`。** 这不是「前端懒」：
 *    静默截断的表现是「填了 16、提示保存成功、回显 2」，管理员会以为没存上，比报错难查
 *    得多（SPEC §9.26）。前端只挡「空着 / 不是整数」这一种——那不是越界，是这一格没填。
 * 3. **不说「已立即生效」。** 打标 worker 下一轮 tick 才读到，而那一轮可能正卡在等一个
 *    在途任务完成上；导入按批次读，**已经在跑的批次整批用旧值**。界面只说「已保存」，
 *    生效的措辞留给下面那段契约文案（SPEC §6.5.5）。
 *
 * ## 为什么不显示「哪一项是默认值」
 *
 * 接口**刻意没有 `source` 字段**（SPEC §5.6）：默认值只有代码常量这一处，等于默认值的
 * 输入在服务端归一成 `NULL`，所以「这一项是不是默认值」这个问题在响应里没有答案。
 * 唯一能说的是 `updatedAt === null` —— 它等价于「这张表没人保存过」，四个列都是 `NULL`。
 */

type FieldName = keyof RuntimeInput

/**
 * 四格的标签与分组。**文案里那两组（打标 / 导入）的顺序就是这里的顺序**，两组都由这个
 * 数组派生（分组名不另写一份，少一处会分叉的知识）。
 */
const FIELDS: readonly { name: FieldName; label: string; group: string }[] = [
  { name: 'tagConcurrency', label: '并发任务数', group: '打标' },
  { name: 'tagPerUserInflight', label: '每用户在途', group: '打标' },
  { name: 'importConcurrency', label: '管线并发', group: '导入' },
  { name: 'ffmpegConcurrency', label: 'ffmpeg 上限', group: '导入' },
]

const GROUPS = [...new Set(FIELDS.map((f) => f.group))]

/**
 * `ffmpegConcurrency` 的**封顶**：上限 = `min(CPU 核数, 16)`（SPEC §5.6）。
 *
 * 这个数在这里出现第二次不是走漏——响应里只有 `cpuCount`（核数），封顶规则没有独立的
 * 字段可以推，而界面要显示「上限 8（本机核数）」就不能在 32 核的机器上把 32 当上限。
 * **服务端仍然是唯一校验点**，它只喂给 `max` 属性和那一行即时提示。
 */
const FFMPEG_CAP = 16

/** 服务端回显的生效值填进表格。遍历 `FIELDS` 而不是手写四行：漏一行不会报错，只是那格静默为空。 */
function toInputs(config: RuntimeConfig): Record<FieldName, string> {
  const values = {} as Record<FieldName, string>
  for (const f of FIELDS) values[f.name] = String(config[f.name])
  return values
}

/**
 * 本地只挡「空着 / 不是整数」，**不做范围判断**（见文件头第 2 条）。
 *
 * 用 `Number.isInteger(Number(v))` 而不是 `parseInt`：`parseInt('3.5')` 给 3、
 * `parseInt('12abc')` 给 12，都是**静默取整**——那正是这一页最不想要的失败形态。
 */
function parseInputs(
  values: Record<FieldName, string>,
): { ok: true; value: RuntimeInput } | { ok: false; message: string } {
  const parsed = {} as RuntimeInput
  for (const f of FIELDS) {
    const raw = values[f.name].trim()
    if (raw === '' || !Number.isInteger(Number(raw))) {
      return { ok: false, message: `「${f.label}」要填一个整数` }
    }
    parsed[f.name] = Number(raw)
  }
  return { ok: true, value: parsed }
}

/**
 * 契约文案里唯一的强调写法是 `**…**`（「保存后**新开的**任务按新值跑」）。
 *
 * 字符串本身**逐字**留在 `settings-copy.ts` 里（好和规则原文 diff），加粗在渲染这一层做：
 * `<pre>` 不解析 markdown，直接渲染出来就是两个字面星号。**不要**为了去掉这两个星号去改
 * 那份字符串——文案是契约，改它要回总管。
 */
export function RuntimeSettings() {
  const [config, setConfig] = useState<RuntimeConfig | null>(null)
  const [values, setValues] = useState<Record<FieldName, string> | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  /** 本地「这一格没填整数」，与服务端的 `VALIDATION_FAILED` 是两回事，所以各一个 state */
  const [shapeError, setShapeError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    let alive = true
    fetchRuntimeConfig()
      .then((cfg) => {
        if (!alive) return
        setConfig(cfg)
        setValues(toInputs(cfg))
      })
      .catch((err) => {
        if (!alive) return
        setLoadError(
          err instanceof ApiError ? `${err.message}（requestId：${err.requestId}）` : '加载失败',
        )
      })
    return () => {
      alive = false
    }
    // 只在挂载时拉一次，理由同 EmbedSettings：依赖数组里放 setter 会变成无限循环
  }, [])

  function setField(name: FieldName, value: string) {
    setValues((prev) => (prev === null ? prev : { ...prev, [name]: value }))
    setShapeError(null)
    // 改过之后「已保存」不再代表现在这四个格里的值，收掉它比留着一句已经不成立的话诚实
    setSaved(false)
  }

  async function save() {
    if (!values) return
    const parsed = parseInputs(values)
    if (!parsed.ok) {
      setShapeError(parsed.message)
      setSaved(false)
      return
    }
    setShapeError(null)
    setSaveError(null)
    setSaved(false)
    setSaving(true)
    try {
      const updated = await putRuntimeConfig(parsed.value)
      setConfig(updated)
      // 回显**服务端返回的**生效值，不是本地那一份：等于默认值的输入在服务端归一成了 NULL，
      // 本地那份只是个字符串，两者在「填了就等于默认值的数」时看不出差别，但那不是重点——
      // 重点是这个格子以后显示的应当是服务端真的在跑的值。
      setValues(toInputs(updated))
      setSaved(true)
    } catch (err) {
      // 复用配置卡片那一份错误呈现（http.md §3：按 code 分支，不解析 message）。
      // `view.retest` 在这里恒为 false——本卡片没有「测试连接」那一步，`CONFIG_TEST_REQUIRED`
      // / `EMBED_DIM_TOO_SMALL` 两个分支走不到，非 admin 那条正是要的（未登录那条由
      // lib/api.ts 统一拦走）。
      const view = describeSaveError(err)
      setSaveError(view.text)
    } finally {
      setSaving(false)
    }
  }

  // ffmpeg 上限的由来：核数与封顶两者取小。32 核的机器上这个数是 16，不是 32。
  const ffmpegCeiling = config ? Math.min(config.cpuCount, FFMPEG_CAP) : 0
  const ffmpegRaw = values?.ffmpegConcurrency.trim() ?? ''
  const ffmpegOver = ffmpegRaw !== '' && Number(ffmpegRaw) > ffmpegCeiling

  return (
    <SettingsCard
      title="运行参数"
      description="打标与导入两条线的并发上限。改完不用重启，对新开的任务生效。"
      /*
        徽标写「每个服务进程」而不是「全站生效」：这四个数每一个都是**每进程**的，
        多副本时全局上限 = 这里的数 × 进程数（SPEC §9.26）。写「全站」在多副本下就是假的，
        而这四个数恰恰是最容易被读成「全站上限」的那一类。
      */
      action={<Badge>每个服务进程</Badge>}
    >
      {loadError && (
        <Alert variant="destructive">
          <AlertTitle>{loadError}</AlertTitle>
        </Alert>
      )}
      {!loadError && (!config || !values) && (
        <p className="text-sm text-muted-foreground">加载中…</p>
      )}

      {config && values && (
        <>
          <p className="text-sm text-muted-foreground">
            {config.updatedAt
              ? `上次修改：${formatDate(config.updatedAt)}`
              : '这张表还没人改过，四个数都是代码默认值'}
          </p>

          {/*
            契约文案，逐字（settings-copy.ts）。缩进与分行是它的结构；`ContractTip` 只切分
            ⚠️ 那句当标题，`**新开的**` 的星号仍由它剥掉后加粗。
          */}
          <ContractTip text={RUNTIME_NOTICE} />

          {GROUPS.map((group) => (
            <fieldset key={group} className="flex w-full max-w-[30rem] flex-col gap-3">
              <legend className="text-sm font-medium">{group}</legend>
              <div className="grid gap-3 sm:grid-cols-2">
                {FIELDS.filter((f) => f.group === group).map((f) => {
                  const id = `runtime-${f.name}`
                  const isFfmpeg = f.name === 'ffmpegConcurrency'
                  return (
                    <div key={f.name} className="flex flex-col gap-1.5">
                      <Label htmlFor={id}>{f.label}</Label>
                      <Input
                        id={id}
                        className={TOUCH}
                        type="number"
                        // 四个格的下限都是 1（SPEC §5.6）。它只给原生步进器一个底，
                        // **范围校验仍然只在服务端**——所以这里没有对应的 max，除了 ffmpeg。
                        min={1}
                        max={isFfmpeg ? ffmpegCeiling : undefined}
                        aria-describedby={isFfmpeg ? `${id}-hint` : undefined}
                        value={values[f.name]}
                        disabled={saving}
                        onChange={(e) => setField(f.name, e.target.value)}
                      />
                      {isFfmpeg && (
                        <p
                          id={`${id}-hint`}
                          // 越界时这一行是错误色并被读屏念出来；正常时它只是一句说明
                          role={ffmpegOver ? 'alert' : undefined}
                          className={cn(
                            'text-xs',
                            ffmpegOver ? 'text-destructive' : 'text-muted-foreground',
                          )}
                        >
                          {ffmpegOver
                            ? `本机 ${config.cpuCount} 核，这一项最大只能填 ${ffmpegCeiling}`
                            : `上限 ${ffmpegCeiling}（本机 ${config.cpuCount} 核）`}
                        </p>
                      )}
                    </div>
                  )
                })}
              </div>
            </fieldset>
          ))}

          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" className={TOUCH} onClick={save} disabled={saving}>
              {saving ? '保存中…' : '保存'}
            </Button>
            {shapeError && (
              <p role="alert" className="text-sm text-destructive">
                {shapeError}
              </p>
            )}
          </div>

          {saveError && (
            <Alert variant="destructive">
              <AlertTitle>{saveError}</AlertTitle>
            </Alert>
          )}
          {/* 不自动消失：自己走掉的提示等于没有提示，而这一页改的是机器资源（http.md §5） */}
          {saved && (
            <p role="status" className="text-sm">
              已保存
            </p>
          )}
        </>
      )}
    </SettingsCard>
  )
}

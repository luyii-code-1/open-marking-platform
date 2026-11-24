import { useMemo, useState, type ReactNode } from 'react'
import { Input, Space } from 'antd'
import { PlusOutlined } from '@ant-design/icons'
import { Button } from './Button'
import './tagPicker.css'

export type TagOption<T extends string | number = string> = {
  label: string
  value: T
  color?: string
  disabled?: boolean
}

export const GRADE_PRESETS = ['高一', '高二', '高三', '初一', '初二', '初三']
export const SUBJECT_PRESETS = ['语文', '数学', '英语', '物理', '化学', '生物', '政治', '历史', '地理']

const COLOR_SWATCH: Record<string, string> = {
  blue: '#1677ff',
  purple: '#722ed1',
  geekblue: '#2f54eb',
  cyan: '#13c2c2',
  green: '#52c41a',
  gold: '#faad14',
  orange: '#fa8c16',
  volcano: '#fa541c',
  red: '#f5222d',
  magenta: '#eb2f96',
  lime: '#a0d911',
  default: '#94a3b8',
}

function resolveColor(color?: string) {
  if (!color) return undefined
  return COLOR_SWATCH[color] || color
}

export function TagPicker<T extends string | number = string>({
  options,
  value,
  onChange,
  allowClear = false,
  clearLabel,
  allowCustom = false,
  customPlaceholder = '点击上方标签快速填充，或输入自定义内容',
  maxLength = 100,
  disabled = false,
  emptyText = '暂无可选项',
  compact = false,
  'aria-label': ariaLabel,
}: {
  options: TagOption<T>[]
  value?: T
  onChange?: (value: T | undefined) => void
  allowClear?: boolean
  clearLabel?: string
  allowCustom?: boolean
  customPlaceholder?: string
  maxLength?: number
  disabled?: boolean
  emptyText?: ReactNode
  compact?: boolean
  'aria-label'?: string
}) {
  const [search, setSearch] = useState('')
  const showSearch = options.length > 24
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return options
    return options.filter(opt => opt.label.toLowerCase().includes(q))
  }, [options, search])

  const selectedText = typeof value === 'string' ? value : ''

  return (
    <div className={`tag-picker${compact ? ' tag-picker-compact' : ''}`} role="group" aria-label={ariaLabel}>
      {showSearch && (
        <Input.Search
          size="small"
          allowClear
          className="tag-picker-search"
          placeholder="筛选标签"
          value={search}
          onChange={e => setSearch(e.target.value)}
          disabled={disabled}
        />
      )}
      <div className="tag-picker-list">
        {clearLabel && (
          <button
            type="button"
            className={`tag-picker-btn${value === undefined || value === '' ? ' is-selected' : ''}`}
            disabled={disabled}
            onClick={() => onChange?.(undefined)}
          >
            {clearLabel}
          </button>
        )}
        {visible.map(opt => {
          const active = value === opt.value
          const dot = resolveColor(opt.color)
          return (
            <button
              type="button"
              key={String(opt.value)}
              className={`tag-picker-btn${active ? ' is-selected' : ''}`}
              disabled={disabled || opt.disabled}
              aria-pressed={active}
              onClick={() => {
                if (active && allowClear) onChange?.(undefined)
                else onChange?.(opt.value)
              }}
            >
              {dot && <span className="tag-picker-dot" style={{ background: dot }} />}
              <span>{opt.label}</span>
            </button>
          )
        })}
        {!visible.length && !clearLabel && !allowCustom && <span className="tag-picker-empty">{emptyText}</span>}
      </div>
      {allowCustom && (
        <Input
          value={selectedText}
          maxLength={maxLength}
          disabled={disabled}
          allowClear={allowClear}
          placeholder={customPlaceholder}
          onChange={e => onChange?.((e.target.value || '') as T)}
        />
      )}
    </div>
  )
}

export function MultiTagPicker<T extends string | number = string>({
  options,
  value = [],
  onChange,
  allowCustom = false,
  customPlaceholder = '输入自定义标签后按回车添加',
  maxLength = 40,
  showSelectAll = false,
  disabled = false,
  emptyText = '暂无可选项',
  compact = false,
  'aria-label': ariaLabel,
}: {
  options: TagOption<T>[]
  value?: T[]
  onChange?: (value: T[]) => void
  allowCustom?: boolean
  customPlaceholder?: string
  maxLength?: number
  showSelectAll?: boolean
  disabled?: boolean
  emptyText?: ReactNode
  compact?: boolean
  'aria-label'?: string
}) {
  const [draft, setDraft] = useState('')
  const [search, setSearch] = useState('')
  const selected = Array.isArray(value) ? value : []
  const mergedOptions = useMemo(() => {
    const existing = new Set(options.map(opt => opt.value))
    const extras: TagOption<T>[] = selected
      .filter(v => !existing.has(v))
      .map(v => ({ label: String(v), value: v }))
    return [...options, ...extras]
  }, [options, selected])

  const showSearch = mergedOptions.length > 24
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return mergedOptions
    return mergedOptions.filter(opt => opt.label.toLowerCase().includes(q))
  }, [mergedOptions, search])

  const selectable = mergedOptions.filter(opt => !opt.disabled).map(opt => opt.value)
  const allSelected = selectable.length > 0 && selectable.every(v => selected.includes(v))

  function toggle(item: T) {
    if (disabled) return
    if (selected.includes(item)) onChange?.(selected.filter(v => v !== item))
    else onChange?.([...selected, item])
  }

  function addCustom() {
    const text = draft.trim()
    if (!text || disabled) return
    const nextVal = text as T
    if (!selected.includes(nextVal)) onChange?.([...selected, nextVal])
    setDraft('')
  }

  return (
    <div className={`tag-picker${compact ? ' tag-picker-compact' : ''}`} role="group" aria-label={ariaLabel}>
      {showSearch && (
        <Input.Search
          size="small"
          allowClear
          className="tag-picker-search"
          placeholder="筛选标签"
          value={search}
          onChange={e => setSearch(e.target.value)}
          disabled={disabled}
        />
      )}
      <div className="tag-picker-list">
        {visible.map(opt => {
          const active = selected.includes(opt.value)
          const dot = resolveColor(opt.color)
          return (
            <button
              type="button"
              key={String(opt.value)}
              className={`tag-picker-btn${active ? ' is-selected' : ''}`}
              disabled={disabled || opt.disabled}
              aria-pressed={active}
              onClick={() => toggle(opt.value)}
            >
              {dot && <span className="tag-picker-dot" style={{ background: dot }} />}
              <span>{opt.label}</span>
            </button>
          )
        })}
        {showSelectAll && selectable.length > 1 && (
          <button
            type="button"
            className="tag-picker-action"
            disabled={disabled}
            onClick={() => onChange?.(allSelected ? [] : selectable)}
          >
            {allSelected ? '清空' : '全选'}
          </button>
        )}
        {!visible.length && !allowCustom && <span className="tag-picker-empty">{emptyText}</span>}
      </div>
      {allowCustom && (
        <Space.Compact className="tag-picker-custom" size="small">
          <Input
            value={draft}
            maxLength={maxLength}
            disabled={disabled}
            placeholder={customPlaceholder}
            onChange={e => setDraft(e.target.value)}
            onPressEnter={e => {
              e.preventDefault()
              addCustom()
            }}
          />
          <Button size="small" icon={<PlusOutlined />} disabled={disabled || !draft.trim()} onClick={addCustom}>
            添加
          </Button>
        </Space.Compact>
      )}
    </div>
  )
}

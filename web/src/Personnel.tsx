import { useMemo, useState } from 'react'
import { App, Checkbox, Form, Input, Modal, Space, Tabs, Tag } from 'antd'
import { BatchDeleteButton, DeleteRecord } from './DeleteRecord'
import { ClassTags, DEFAULT_CLASS_TAGS, GradeTag, classTagColor, gradeColor } from './SchoolTags'
import { MultiTagPicker, SUBJECT_PRESETS, TagPicker } from './TagPicker'
import { TagsManager } from './TagsManager'
import { TeacherImport } from './Teaching'
import { StudentImport } from './StudentImport'
import { Grades } from './Grades'
import { Button } from './Button'
import { send, useResource, type Row } from './api'
import { EntityTable, ErrorNotice } from './EntityTable'
import { MultipleRecordSelect, RecordSelect } from './RecordSelect'
import type { FilterField, FilterValues } from './recordFilters'

export function Personnel({
  systemAdmin = false,
  tab,
  onTab,
}: {
  systemAdmin?: boolean
  tab?: string
  onTab?: (key: string) => void
}) {
  const classes = useResource<Row[]>('/classes', [])
  const students = useResource<Row[]>('/students', [])
  const users = useResource<Row[]>('/users', [])
  const grades = useResource<Row[]>('/grades', [])
  const subjects = useResource<Row[]>('/subjects', [])
  const subjectTags = useResource<Row[]>('/subject-tags', [])
  const tagMap = useResource<{ tags: Row[]; by_student: Record<string, string[]>; colors: Record<string, string> }>(
    '/tags/student-map',
    { tags: [], by_student: {}, colors: {} },
  )

  const [selected, setSelected] = useState<Row | null>(null)
  const [kind, setKind] = useState('classes')
  const [name, setName] = useState('')
  const [grade, setGrade] = useState('')
  const [candidate, setCandidate] = useState('')
  const [classId, setClassId] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState('teacher')
  const [busy, setBusy] = useState(false)
  const [teachers, setTeachers] = useState<string[]>([])
  const [roles, setRoles] = useState<Record<string, { subjects: string[]; homeroom: boolean | null }>>({})
  const [classTags, setClassTags] = useState<string[]>([])
  const [studentTags, setStudentTags] = useState<string[]>([])
  const [teacherSubjects, setTeacherSubjects] = useState<string[]>([])
  const [teacherGradeIds, setTeacherGradeIds] = useState<string[]>([])
  const [teacherCustomTags, setTeacherCustomTags] = useState<string[]>([])
  const [teacherClassIds, setTeacherClassIds] = useState<string[]>([])
  const [teacherIsHomeroom, setTeacherIsHomeroom] = useState(false)
  const [teacherHomeroomClassIds, setTeacherHomeroomClassIds] = useState<string[]>([])
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([])
  const [selectedClassIds, setSelectedClassIds] = useState<string[]>([])
  const [selectedStudentIds, setSelectedStudentIds] = useState<string[]>([])
  const [batchTagOpen, setBatchTagOpen] = useState(false)
  const [batchTagTarget, setBatchTagTarget] = useState<'classes' | 'students'>('classes')
  const [batchTagMode, setBatchTagMode] = useState<'replace' | 'add' | 'clear'>('replace')
  const [batchTags, setBatchTags] = useState<string[]>([])
  const [batchPwdOpen, setBatchPwdOpen] = useState(false)
  const [batchPwd, setBatchPwd] = useState('')
  const [batchRoleOpen, setBatchRoleOpen] = useState(false)
  const [batchRole, setBatchRole] = useState<'teacher' | 'manager'>('teacher')
  const [teacherFilters, setTeacherFilters] = useState<FilterValues>({})
  const [classFilters, setClassFilters] = useState<FilterValues>({})
  const [studentFilters, setStudentFilters] = useState<FilterValues>({})
  const { message, modal } = App.useApp()

  const applyTeacherFilter = (key: string, val: string) => {
    if (!val) return
    setTeacherFilters(prev => {
      const cur = prev[key] || []
      return { ...prev, [key]: cur.includes(val) ? cur : [...cur, val] }
    })
  }
  const applyClassFilter = (key: string, val: string) => {
    if (!val) return
    setClassFilters(prev => {
      const cur = prev[key] || []
      return { ...prev, [key]: cur.includes(val) ? cur : [...cur, val] }
    })
  }
  const applyStudentFilter = (key: string, val: string) => {
    if (!val) return
    setStudentFilters(prev => {
      const cur = prev[key] || []
      return { ...prev, [key]: cur.includes(val) ? cur : [...cur, val] }
    })
  }
  const applyClassTagFilter = (tagName: string) => applyClassFilter('tag', tagName)
  const applyStudentTagFilter = (tagName: string) => applyStudentFilter('tag', tagName)
  const jumpToStudentsByTag = (tagName: string) => {
    if (tagName === '班主任') {
      setTeacherFilters({ tag: ['班主任'] })
      onTab?.('users')
      return
    }
    setStudentFilters({ tag: [tagName] })
    onTab?.('students')
  }
  const jumpToClassesByTag = (row: Row) => {
    if (row.category === 'grade' && row.ref_id) setClassFilters({ grade: [row.ref_id] })
    else setClassFilters({ tag: [row.name] })
    onTab?.('classes')
  }

  const subjectChoices = [
    ...new Set([...subjectTags.data.map(t => t.name), ...subjects.data.map(s => s.name), ...SUBJECT_PRESETS].filter(Boolean)),
  ].map(value => ({
    label: String(value),
    value: String(value),
  }))
  const tagColors = tagMap.data.colors || {}
  const customTagNames = useMemo(
    () =>
      [
        ...new Set([
          ...DEFAULT_CLASS_TAGS,
          ...(tagMap.data.tags || []).filter(t => !t.builtin).map(t => String(t.name)),
          ...classes.data.flatMap(c => (Array.isArray(c.tags) ? c.tags.map(String) : [])),
        ].filter(Boolean)),
      ],
    [tagMap.data.tags, classes.data],
  )
  const classTagOptions = useMemo(() => customTagNames.map(value => ({ value, label: value })), [customTagNames])
  const allTagOptions = useMemo(
    () =>
      [...new Set([...(tagMap.data.tags || []).map(t => String(t.name)), ...customTagNames].filter(Boolean))].map(value => ({
        value,
        label: value,
      })),
    [tagMap.data.tags, customTagNames],
  )
  const studentAllTags = (s: Row) => tagMap.data.by_student?.[s.id] || [...(classes.data.find(c => c.id === s.class_id)?.tags || []), ...(s.tags || [])]
  const gradeName = (id: string) => grades.data.find(g => g.id === id)?.name
  const classLabel = (id: string) => {
    const c = classes.data.find(item => item.id === id)
    return c ? [gradeName(c.grade_id), c.name].filter(Boolean).join(' · ') : ''
  }
  const teacherName = (id: string) => users.data.find(u => u.id === id)?.name || id
  const gradeOptions = grades.data.map(g => ({ value: g.id, label: g.name }))
  const teacherOptions = users.data.filter(u => u.role === 'teacher').map(u => ({ value: u.id, label: u.name }))
  const classFields: FilterField<Row>[] = [
    { key: 'grade', label: '年级', options: gradeOptions, values: c => [c.grade_id] },
    { key: 'tag', label: '班级标签', options: classTagOptions, values: c => c.tags || [] },
    { key: 'teacher', label: '任教教师', options: teacherOptions, values: c => c.teacher_ids || [] },
  ]
  const teacherMetaById = useMemo(() => {
    const gradeById = new Map(grades.data.map(g => [g.id, g.name]))
    const map = new Map<
      string,
      {
        subjects: string[]
        gradeIds: string[]
        tags: string[]
        classes: { id: string; label: string; homeroom: boolean }[]
        homeroomClasses: { id: string; label: string }[]
      }
    >()
    const ensure = (uid: string) => {
      let item = map.get(uid)
      if (!item) {
        item = { subjects: [], gradeIds: [], tags: [], classes: [], homeroomClasses: [] }
        map.set(uid, item)
      }
      return item
    }
    for (const u of users.data) {
      const meta = ensure(u.id)
      for (const s of (u.subjects || []) as string[]) {
        if (s && !meta.subjects.includes(s)) meta.subjects.push(s)
      }
      for (const gid of (u.grade_ids || []) as string[]) {
        if (gid && !meta.gradeIds.includes(gid)) meta.gradeIds.push(gid)
      }
      for (const t of (u.tags || []) as string[]) {
        if (t && !meta.tags.includes(t)) meta.tags.push(t)
      }
    }
    for (const c of classes.data) {
      const gName = gradeById.get(c.grade_id) || ''
      const label = [gName, c.name].filter(Boolean).join(' · ')
      const teaching = (c.teaching || {}) as Record<string, { subjects?: string[]; homeroom?: boolean | null }>
      const uids = new Set<string>([...(c.teacher_ids || []), ...Object.keys(teaching)])
      for (const uid of uids) {
        const meta = ensure(uid)
        const roleInfo = teaching[uid] || {}
        for (const s of roleInfo.subjects || []) {
          if (s && !meta.subjects.includes(s)) meta.subjects.push(s)
        }
        if (c.grade_id && !meta.gradeIds.includes(c.grade_id)) meta.gradeIds.push(c.grade_id)
        for (const t of (c.tags || []) as string[]) {
          if (t && !meta.tags.includes(t)) meta.tags.push(t)
        }
        if (!meta.classes.some(item => item.id === c.id)) {
          meta.classes.push({ id: c.id, label, homeroom: roleInfo.homeroom === true })
        }
        if (roleInfo.homeroom === true && !meta.homeroomClasses.some(item => item.id === c.id)) {
          meta.homeroomClasses.push({ id: c.id, label })
          if (!meta.tags.includes('班主任')) meta.tags.unshift('班主任')
        }
      }
    }
    return map
  }, [classes.data, grades.data, users.data])

  const taughtSubjectOptions = useMemo(() => {
    const names = new Set<string>()
    for (const meta of teacherMetaById.values()) {
      for (const s of meta.subjects) names.add(s)
    }
    for (const c of subjectChoices) names.add(c.value)
    return [...names].sort().map(value => ({ value, label: value }))
  }, [teacherMetaById, subjectChoices])

  const teacherFields: FilterField<Row>[] = [
    {
      key: 'role',
      label: '角色',
      options: [
        { value: 'teacher', label: '阅卷教师' },
        { value: 'manager', label: '管理教师' },
        { value: 'admin', label: '系统管理员' },
      ],
      values: u => [u.role || 'teacher'],
    },
    {
      key: 'subject',
      label: '任课科目',
      options: taughtSubjectOptions,
      values: u => teacherMetaById.get(u.id)?.subjects || [],
    },
    {
      key: 'grade',
      label: '任教年级',
      options: gradeOptions,
      values: u => teacherMetaById.get(u.id)?.gradeIds || [],
    },
    {
      key: 'tag',
      label: '标签',
      options: [{ value: '班主任', label: '班主任' }, ...classTagOptions.filter(o => o.value !== '班主任')],
      values: u => teacherMetaById.get(u.id)?.tags || [],
    },
    {
      key: 'class',
      label: '任教班级',
      options: classes.data.map(c => ({ value: c.id, label: classLabel(c.id) })),
      values: u => (teacherMetaById.get(u.id)?.classes || []).map(c => c.id),
    },
  ]
  const studentFields: FilterField<Row>[] = [
    { key: 'grade', label: '年级', options: gradeOptions, values: s => [classes.data.find(c => c.id === s.class_id)?.grade_id || ''] },
    { key: 'tag', label: '标签', options: allTagOptions, values: s => studentAllTags(s) },
    { key: 'class', label: '行政班', options: classes.data.map(c => ({ value: c.id, label: classLabel(c.id) })), values: s => [s.class_id] },
  ]

  const validUserIds = useMemo(
    () => selectedUserIds.filter(id => users.data.some(u => u.id === id && u.role === 'teacher')),
    [selectedUserIds, users.data],
  )
  const validClassIds = useMemo(
    () => selectedClassIds.filter(id => classes.data.some(c => c.id === id)),
    [selectedClassIds, classes.data],
  )
  const validStudentIds = useMemo(
    () => selectedStudentIds.filter(id => students.data.some(s => s.id === id)),
    [selectedStudentIds, students.data],
  )

  const reloadAll = async () => {
    await Promise.all([classes.reload(), students.reload(), users.reload(), grades.reload(), tagMap.reload()])
  }

  async function save() {
    if (!selected) return
    setBusy(true)
    try {
      await send(
        `/${kind}/${selected.id}`,
        kind === 'classes'
          ? {
              name,
              grade_id: grade,
              tags: classTags,
              teacher_ids: teachers,
              teaching: Object.fromEntries(teachers.filter(id => roles[id]).map(id => [id, roles[id]])),
              previous_teaching: selected.teaching || {},
              previous_teacher_ids: selected.teacher_ids || [],
            }
          : kind === 'students'
            ? { name, candidate_number: candidate, class_id: classId, tags: studentTags }
            : { name, ...(systemAdmin ? { role } : {}) },
        'PUT',
      )
      if (kind === 'users' && password) await send(`/users/${selected.id}/reset-password`, { password })
      if (kind === 'users' && (role === 'teacher' || selected.role === 'teacher')) {
        await send(
          `/teaching/teacher/${selected.id}`,
          {
            subjects: teacherSubjects,
            grade_ids: teacherGradeIds,
            tags: teacherCustomTags,
            class_ids: teacherClassIds,
            homeroom_class_ids: teacherIsHomeroom ? teacherHomeroomClassIds : [],
          },
          'PUT',
        )
      }
      message.success('已保存')
      setSelected(null)
      await reloadAll()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function saveBatchTags() {
    const ids = batchTagTarget === 'classes' ? validClassIds : validStudentIds
    if (!ids.length || busy) return
    setBusy(true)
    try {
      const endpoint = batchTagTarget === 'classes' ? '/classes/batch-tags' : '/students/batch-tags'
      const body =
        batchTagTarget === 'classes'
          ? { class_ids: ids, tags: batchTags, mode: batchTagMode }
          : { student_ids: ids, tags: batchTags, mode: batchTagMode }
      const res = await send<{ updated: number }>(endpoint, body)
      message.success(`已更新 ${res.updated} 项标签`)
      setBatchTagOpen(false)
      await reloadAll()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function saveBatchPassword() {
    if (!validUserIds.length || busy) return
    if (batchPwd.length < 10 || batchPwd.length > 200) {
      message.warning('密码需 10 至 200 个字符')
      return
    }
    setBusy(true)
    try {
      const res = await send<{ updated: number }>('/users/batch-reset-password', {
        user_ids: validUserIds,
        password: batchPwd,
      })
      message.success(`已将 ${res.updated} 个账号的密码重置为指定密码`)
      setBatchPwdOpen(false)
      setBatchPwd('')
      setSelectedUserIds([])
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  function confirmBatchForceLogout() {
    if (!validUserIds.length || busy) return
    modal.confirm({
      title: `强制下线已选 ${validUserIds.length} 个教师账号？`,
      content: '操作后这些账号当前的登录会话将立即失效，需要重新登录。',
      okText: '确认下线',
      cancelText: '取消',
      onOk: async () => {
        const res = await send<{ updated: number }>('/users/batch-force-logout', { user_ids: validUserIds })
        message.success(`已强制下线 ${res.updated} 个账号`)
        setSelectedUserIds([])
      },
    })
  }

  async function saveBatchRole() {
    if (!validUserIds.length || busy) return
    setBusy(true)
    try {
      const res = await send<{ updated: number }>('/users/batch-role', {
        user_ids: validUserIds,
        role: batchRole,
      })
      message.success(`已更新 ${res.updated} 个账号的角色`)
      setBatchRoleOpen(false)
      setSelectedUserIds([])
      await reloadAll()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  function edit(type: string, row: Row) {
    setTeachers(row.teacher_ids || [])
    setRoles(row.teaching || {})
    setClassTags(Array.isArray(row.tags) ? row.tags.map(String) : [])
    setStudentTags(Array.isArray(row.tags) ? row.tags.map(String) : [])
    if (type === 'users') {
      const meta = teacherMetaById.get(row.id)
      const taughtIds = (meta?.classes || []).map(c => c.id)
      const hrIds = (meta?.homeroomClasses || []).map(c => c.id)
      setTeacherSubjects(meta?.subjects || [])
      setTeacherGradeIds(meta?.gradeIds || [])
      setTeacherCustomTags(Array.isArray(row.tags) ? row.tags.map(String) : [])
      setTeacherClassIds(taughtIds)
      setTeacherIsHomeroom(hrIds.length > 0)
      setTeacherHomeroomClassIds(hrIds)
    }
    setKind(type)
    setSelected(row)
    setRole(row.role || 'teacher')
    setName(row.name)
    setGrade(row.grade_id || '')
    setCandidate(row.candidate_number || '')
    setClassId(row.class_id || '')
    setPassword('')
  }

  return (
    <>
      <ErrorNotice error={classes.error || students.error || users.error || grades.error} retry={reloadAll} />
      <Tabs
        activeKey={tab === 'teaching' ? 'users' : tab}
        onChange={onTab}
        items={[
          {
            key: 'users',
            label: '教师账号',
            children: (
              <EntityTable
                hideTitle
                filterFields={teacherFields}
                filterValues={teacherFilters}
                onFilterValuesChange={setTeacherFilters}
                searchText={u => {
                  const meta = teacherMetaById.get(u.id)
                  return [
                    u.username,
                    u.name,
                    u.role === 'admin' ? '系统管理员' : u.role === 'manager' ? '管理教师' : '阅卷教师',
                    ...(meta?.subjects || []),
                    ...(meta?.gradeIds.map(id => gradeName(id) || '') || []),
                    ...(meta?.tags || []),
                    ...(meta?.classes.map(c => c.label) || []),
                  ]
                }}
                resource={users}
                allowImport={false}
                extra={
                  <TeacherImport
                    classes={classes.data}
                    users={users.data}
                    grades={grades.data}
                    reload={async () => Promise.all([users.reload(), classes.reload()])}
                  />
                }
                path="/users"
                title="教师账号"
                rowSelection={{
                  selectedRowKeys: validUserIds,
                  onChange: keys => setSelectedUserIds(keys.map(String)),
                  getCheckboxProps: row => ({ disabled: row.role !== 'teacher' }),
                }}
                selectionBar={
                  validUserIds.length > 0 && (
                    <div className="selection-action-bar">
                      <span className="selection-action-summary">已选 {validUserIds.length} 个教师账号</span>
                      <Space size={8} wrap>
                        <Button
                          size="small"
                          onClick={() => {
                            setBatchPwd('')
                            setBatchPwdOpen(true)
                          }}
                        >
                          批量重置密码（{validUserIds.length}）
                        </Button>
                        <Button size="small" onClick={confirmBatchForceLogout}>
                          批量强制下线
                        </Button>
                        {systemAdmin && (
                          <Button
                            size="small"
                            onClick={() => {
                              setBatchRole('teacher')
                              setBatchRoleOpen(true)
                            }}
                          >
                            批量设置角色
                          </Button>
                        )}
                        <BatchDeleteButton
                          kind="users"
                          ids={validUserIds}
                          onDeleted={async () => {
                            setSelectedUserIds([])
                            await reloadAll()
                          }}
                        />
                        <Button size="small" type="text" onClick={() => setSelectedUserIds([])}>
                          清空选择
                        </Button>
                      </Space>
                    </div>
                  )
                }
                fields={[
                  { name: 'username', label: '账号' },
                  { name: 'name', label: '姓名' },
                  { name: 'password', label: '初始密码', type: 'password' },
                  {
                    name: 'role',
                    label: '角色',
                    type: 'select',
                    initial: 'teacher',
                    options: [
                      { label: '阅卷教师', value: 'teacher' },
                      ...(systemAdmin
                        ? [
                            { label: '管理教师', value: 'manager' },
                            { label: '系统管理员', value: 'admin' },
                          ]
                        : []),
                    ],
                  },
                ]}
                columns={[
                  { title: '账号', dataIndex: 'username' },
                  { title: '姓名', dataIndex: 'name' },
                  {
                    title: '角色',
                    dataIndex: 'role',
                    render: (value: string) => {
                      const label = value === 'admin' ? '系统管理员' : value === 'manager' ? '管理教师' : '阅卷教师'
                      return (
                        <Tag
                          color={value === 'admin' ? 'red' : value === 'manager' ? 'purple' : 'default'}
                          style={{ cursor: 'pointer', marginInlineEnd: 0 }}
                          onClick={() => applyTeacherFilter('role', value || 'teacher')}
                        >
                          {label}
                        </Tag>
                      )
                    },
                  },
                  {
                    title: '任课科目',
                    render: (_, row) => {
                      const list = teacherMetaById.get(row.id)?.subjects || []
                      return list.length ? (
                        <ClassTags tags={list} colorMap={tagColors} onTagClick={s => applyTeacherFilter('subject', s)} />
                      ) : (
                        '—'
                      )
                    },
                  },
                  {
                    title: '任教年级',
                    render: (_, row) => {
                      const gids = teacherMetaById.get(row.id)?.gradeIds || []
                      return gids.length ? (
                        <Space size={4} wrap>
                          {gids.map(gid => (
                            <GradeTag key={gid} name={gradeName(gid)} onClick={() => applyTeacherFilter('grade', gid)} />
                          ))}
                        </Space>
                      ) : (
                        '—'
                      )
                    },
                  },
                  {
                    title: '标签',
                    render: (_, row) => {
                      const tags = teacherMetaById.get(row.id)?.tags || []
                      return tags.length ? (
                        <ClassTags tags={tags} colorMap={tagColors} onTagClick={t => applyTeacherFilter('tag', t)} />
                      ) : (
                        '—'
                      )
                    },
                  },
                  {
                    title: '任教班级',
                    render: (_, row) => {
                      const cls = teacherMetaById.get(row.id)?.classes || []
                      if (!cls.length) return '—'
                      const labels = cls.map(c => (c.homeroom ? `${c.label}（班主任）` : c.label))
                      const labelToId = new Map(cls.map((c, idx) => [labels[idx], c.id]))
                      return (
                        <ClassTags
                          tags={labels}
                          onTagClick={label => {
                            const cid = labelToId.get(label)
                            if (cid) applyTeacherFilter('class', cid)
                          }}
                        />
                      )
                    },
                  },
                  {
                    title: '操作',
                    render: (_, row) => (
                      <Space>
                        <Button disabled={!systemAdmin && row.role !== 'teacher'} onClick={() => edit('users', row)}>
                          编辑 / 任教设置
                        </Button>
                        {row.role === 'teacher' && (
                          <DeleteRecord
                            kind="users"
                            row={row}
                            reload={async () => {
                              setSelectedUserIds(ids => ids.filter(id => id !== row.id))
                              await reloadAll()
                            }}
                          />
                        )}
                      </Space>
                    ),
                  },
                ]}
              />
            ),
          },
          {
            key: 'grades',
            label: '年级',
            children: <Grades onChanged={reloadAll} />,
          },
          {
            key: 'classes',
            label: '班级',
            children: (
              <EntityTable
                hideTitle
                filterFields={classFields}
                filterValues={classFilters}
                onFilterValuesChange={setClassFilters}
                resource={classes}
                searchText={c => [gradeName(c.grade_id), ...(c.tags || []), ...(c.teacher_ids || []).map(teacherName)]}
                path="/classes"
                title="班级"
                rowSelection={{
                  selectedRowKeys: validClassIds,
                  onChange: keys => setSelectedClassIds(keys.map(String)),
                }}
                selectionBar={
                  validClassIds.length > 0 && (
                    <div className="selection-action-bar">
                      <span className="selection-action-summary">已选 {validClassIds.length} 个班级</span>
                      <Space size={8}>
                        <Button
                          size="small"
                          onClick={() => {
                            setBatchTagTarget('classes')
                            setBatchTagMode('replace')
                            setBatchTags([])
                            setBatchTagOpen(true)
                          }}
                        >
                          批量设置标签（{validClassIds.length}）
                        </Button>
                        <BatchDeleteButton
                          kind="classes"
                          ids={validClassIds}
                          onDeleted={async () => {
                            setSelectedClassIds([])
                            await reloadAll()
                          }}
                        />
                        <Button size="small" type="text" onClick={() => setSelectedClassIds([])}>
                          清空选择
                        </Button>
                      </Space>
                    </div>
                  )
                }
                fields={[
                  { name: 'name', label: '班级名称' },
                  {
                    name: 'grade_id',
                    label: '年级',
                    type: 'select',
                    options: grades.data.filter(g => !g.archived).map(g => ({ label: g.name, value: g.id })),
                  },
                ]}
                creationFields={
                  <Form.Item name="tags" label="自定义标签（可选）">
                    <MultiTagPicker
                      allowCustom
                      options={classTagOptions.map(o => ({ ...o, color: classTagColor(o.value, tagColors) }))}
                      customPlaceholder="输入自定义标签后按回车添加"
                    />
                  </Form.Item>
                }
                columns={[
                  { title: '班级', dataIndex: 'name' },
                  {
                    title: '年级',
                    dataIndex: 'grade_id',
                    render: id => <GradeTag name={gradeName(id)} colorMap={tagColors} onClick={() => applyClassFilter('grade', id)} />,
                  },
                  { title: '自定义标签', dataIndex: 'tags', render: (tags: string[]) => <ClassTags tags={tags} colorMap={tagColors} onTagClick={applyClassTagFilter} /> },
                  {
                    title: '任教教师',
                    dataIndex: 'teacher_ids',
                    render: value => (
                      <Space wrap size={[4, 4]}>
                        {(value || []).map((id: string) => (
                          <Tag
                            key={id}
                            color="cyan"
                            style={{ cursor: 'pointer', marginInlineEnd: 0 }}
                            title={`点击筛选「${teacherName(id)}」任教的班级`}
                            onClick={e => {
                              e.stopPropagation()
                              applyClassFilter('teacher', id)
                            }}
                          >
                            {teacherName(id)}
                          </Tag>
                        ))}
                      </Space>
                    ),
                  },
                  {
                    title: '操作',
                    render: (_, row) => (
                      <Space>
                        <Button onClick={() => edit('classes', row)}>编辑</Button>
                        <DeleteRecord
                          kind="classes"
                          row={row}
                          reload={async () => {
                            setSelectedClassIds(ids => ids.filter(id => id !== row.id))
                            await reloadAll()
                          }}
                        />
                      </Space>
                    ),
                  },
                ]}
              />
            ),
          },
          {
            key: 'students',
            label: '学生',
            children: (
              <EntityTable
                hideTitle
                filterFields={studentFields}
                filterValues={studentFilters}
                onFilterValuesChange={setStudentFilters}
                resource={students}
                searchText={s => [classLabel(s.class_id), ...studentAllTags(s)]}
                allowImport={false}
                extra={
                  <StudentImport
                    grades={grades.data}
                    onSaved={async () => {
                      await reloadAll()
                    }}
                  />
                }
                path="/students"
                title="学生"
                rowSelection={{
                  selectedRowKeys: validStudentIds,
                  onChange: keys => setSelectedStudentIds(keys.map(String)),
                }}
                selectionBar={
                  validStudentIds.length > 0 && (
                    <div className="selection-action-bar">
                      <span className="selection-action-summary">已选 {validStudentIds.length} 名学生</span>
                      <Space size={8}>
                        <Button
                          size="small"
                          onClick={() => {
                            setBatchTagTarget('students')
                            setBatchTagMode('add')
                            setBatchTags([])
                            setBatchTagOpen(true)
                          }}
                        >
                          批量设置标签（{validStudentIds.length}）
                        </Button>
                        <BatchDeleteButton
                          kind="students"
                          ids={validStudentIds}
                          onDeleted={async () => {
                            setSelectedStudentIds([])
                            await reloadAll()
                          }}
                        />
                        <Button size="small" type="text" onClick={() => setSelectedStudentIds([])}>
                          清空选择
                        </Button>
                      </Space>
                    </div>
                  )
                }
                fields={[
                  { name: 'name', label: '姓名' },
                  { name: 'candidate_number', label: '准考证号' },
                  {
                    name: 'class_id',
                    label: '班级',
                    type: 'select',
                    options: classes.data.map(c => ({
                      label: `${grades.data.find(g => g.id === c.grade_id)?.name || c.grade || ''} · ${c.name}`,
                      value: c.id,
                    })),
                  },
                ]}
                columns={[
                  { title: '姓名', dataIndex: 'name' },
                  { title: '考号', dataIndex: 'candidate_number' },
                  {
                    title: '年级',
                    dataIndex: 'class_id',
                    render: id => {
                      const gid = classes.data.find(c => c.id === id)?.grade_id
                      return <GradeTag name={gradeName(gid)} colorMap={tagColors} onClick={gid ? () => applyStudentFilter('grade', gid) : undefined} />
                    },
                  },
                  { title: '班级', dataIndex: 'class_id', render: id => classes.data.find(c => c.id === id)?.name || id },
                  { title: '标签', width: 240, render: (_, row) => <ClassTags tags={studentAllTags(row)} colorMap={tagColors} onTagClick={applyStudentTagFilter} /> },
                  {
                    title: '操作',
                    render: (_, row) => (
                      <Space>
                        <Button onClick={() => edit('students', row)}>编辑</Button>
                        <DeleteRecord
                          kind="students"
                          row={row}
                          reload={async () => {
                            setSelectedStudentIds(ids => ids.filter(id => id !== row.id))
                            await reloadAll()
                          }}
                        />
                      </Space>
                    ),
                  },
                ]}
              />
            ),
          },
          {
            key: 'tags',
            label: '标签',
            children: (
              <TagsManager
                classes={classes.data}
                students={students.data}
                grades={grades.data}
                onChanged={reloadAll}
                onFilterByTag={jumpToStudentsByTag}
                onFilterClassesByTag={jumpToClassesByTag}
              />
            ),
          },
        ]}
      />
      <Modal
        title={kind === 'users' ? '编辑教师与任教设置' : '编辑信息'}
        width={640}
        open={!!selected}
        onCancel={() => setSelected(null)}
        onOk={save}
        confirmLoading={busy}
        okButtonProps={{ disabled: !name.trim() }}
      >
        <Form layout="vertical">
          <Form.Item label="姓名 / 名称">
            <Input value={name} onChange={e => setName(e.target.value)} />
          </Form.Item>
          {kind === 'classes' && (
            <>
              <Form.Item label="年级">
                <TagPicker
                  value={grade || undefined}
                  onChange={v => setGrade(v || '')}
                  options={grades.data
                    .filter(g => !g.archived || g.id === grade)
                    .map(g => ({ label: g.name, value: g.id, color: gradeColor(g.name, tagColors) }))}
                />
              </Form.Item>
              <Form.Item label="自定义标签">
                <MultiTagPicker
                  allowCustom
                  value={classTags}
                  onChange={setClassTags}
                  options={classTagOptions.map(o => ({ ...o, color: classTagColor(o.value, tagColors) }))}
                  customPlaceholder="输入自定义标签后按回车添加"
                />
              </Form.Item>
              <Form.Item label="任教教师">
                <MultipleRecordSelect
                  title="任教教师"
                  kind="users"
                  value={teachers}
                  onChange={setTeachers}
                  records={users.data.filter(u => u.role === 'teacher')}
                  fields={teacherFields}
                  columns={[
                    { title: '姓名', dataIndex: 'name' },
                    { title: '账号', dataIndex: 'username' },
                  ]}
                />
              </Form.Item>
              {teachers.map(id => {
                const teacherRole = roles[id] || { subjects: [], homeroom: null }
                return (
                  <Form.Item key={id} label={<Tag color="cyan">{teacherName(id)}</Tag>}>
                    <Space direction="vertical" size={6} style={{ width: '100%' }}>
                      <MultiTagPicker
                        compact
                        allowCustom
                        aria-label="任教学科"
                        value={teacherRole.subjects}
                        options={subjectChoices}
                        customPlaceholder="输入自定义学科后按回车"
                        onChange={v => setRoles({ ...roles, [id]: { ...teacherRole, subjects: v } })}
                      />
                      <Checkbox
                        checked={teacherRole.homeroom === true}
                        onChange={e => setRoles({ ...roles, [id]: { ...teacherRole, homeroom: e.target.checked } })}
                      >
                        班主任
                      </Checkbox>
                    </Space>
                  </Form.Item>
                )
              })}
            </>
          )}
          {kind === 'students' && (
            <>
              <Form.Item label="准考证号">
                <Input value={candidate} onChange={e => setCandidate(e.target.value)} />
              </Form.Item>
              <Form.Item label="班级">
                <RecordSelect
                  title="行政班"
                  kind="classes"
                  value={classId}
                  onChange={setClassId}
                  records={classes.data}
                  fields={classFields}
                  label={c => classLabel(c.id)}
                  columns={[
                    { title: '班级', dataIndex: 'name' },
                    { title: '年级', render: (_, c) => gradeName(c.grade_id) },
                    { title: '标签', render: (_, c) => <ClassTags tags={c.tags} colorMap={tagColors} /> },
                  ]}
                />
              </Form.Item>
              <Form.Item label="个人自定义标签（班级/年级/选科标签自动继承）">
                <MultiTagPicker
                  allowCustom
                  value={studentTags}
                  onChange={setStudentTags}
                  options={classTagOptions.map(o => ({ ...o, color: classTagColor(o.value, tagColors) }))}
                  customPlaceholder="输入自定义标签后按回车添加"
                />
              </Form.Item>
            </>
          )}
          {kind === 'users' && systemAdmin && (
            <Form.Item label="角色">
              <TagPicker
                value={role}
                onChange={v => v && setRole(v)}
                options={[
                  { value: 'teacher', label: '阅卷教师', color: 'default' },
                  { value: 'manager', label: '管理教师', color: 'purple' },
                  { value: 'admin', label: '系统管理员', color: 'red' },
                ]}
              />
            </Form.Item>
          )}
          {kind === 'users' && (role === 'teacher' || selected?.role === 'teacher') && (
            <>
              <Form.Item label="任课科目">
                <MultiTagPicker
                  allowCustom
                  value={teacherSubjects}
                  onChange={setTeacherSubjects}
                  options={subjectChoices}
                  customPlaceholder="输入自定义科目后按回车添加"
                />
              </Form.Item>
              <Form.Item label="任教年级（未绑定行政班时也可单独归属年级）">
                <MultiTagPicker
                  value={teacherGradeIds}
                  onChange={setTeacherGradeIds}
                  options={grades.data
                    .filter(g => !g.archived || teacherGradeIds.includes(g.id))
                    .map(g => ({ label: g.name, value: g.id, color: gradeColor(g.name, tagColors) }))}
                />
              </Form.Item>
              <Form.Item label="任教班级">
                <MultipleRecordSelect
                  title="任教班级"
                  kind="classes"
                  value={teacherClassIds}
                  onChange={setTeacherClassIds}
                  records={classes.data}
                  fields={classFields}
                  columns={[
                    { title: '年级', render: (_, c) => gradeName(c.grade_id) },
                    { title: '班级', dataIndex: 'name' },
                    { title: '标签', render: (_, c) => <ClassTags tags={c.tags} colorMap={tagColors} /> },
                  ]}
                />
              </Form.Item>
              <Form.Item label="班主任设置">
                <Space direction="vertical" size={8} style={{ width: '100%' }}>
                  <Checkbox
                    checked={teacherIsHomeroom}
                    onChange={e => {
                      setTeacherIsHomeroom(e.target.checked)
                      if (!e.target.checked) setTeacherHomeroomClassIds([])
                    }}
                  >
                    设为班主任
                  </Checkbox>
                  {teacherIsHomeroom && (
                    <MultipleRecordSelect
                      title="班主任班级"
                      kind="classes"
                      value={teacherHomeroomClassIds}
                      onChange={setTeacherHomeroomClassIds}
                      records={classes.data}
                      fields={classFields}
                      columns={[
                        { title: '年级', render: (_, c) => gradeName(c.grade_id) },
                        { title: '班级', dataIndex: 'name' },
                        { title: '标签', render: (_, c) => <ClassTags tags={c.tags} colorMap={tagColors} /> },
                      ]}
                    />
                  )}
                </Space>
              </Form.Item>
              <Form.Item label="教师自定义标签（如 2+4、产假、走班等）">
                <MultiTagPicker
                  allowCustom
                  value={teacherCustomTags}
                  onChange={setTeacherCustomTags}
                  options={classTagOptions.map(o => ({ ...o, color: classTagColor(o.value, tagColors) }))}
                  customPlaceholder="输入标签后按回车添加"
                />
              </Form.Item>
            </>
          )}
          {kind === 'users' && (
            <Form.Item label="重置密码（不修改时留空）">
              <Input.Password autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} />
            </Form.Item>
          )}
        </Form>
      </Modal>
      <Modal
        title={`批量设置${batchTagTarget === 'classes' ? '班级' : '学生'}标签（已选 ${batchTagTarget === 'classes' ? validClassIds.length : validStudentIds.length} 项）`}
        open={batchTagOpen}
        onCancel={() => !busy && setBatchTagOpen(false)}
        onOk={() => void saveBatchTags()}
        confirmLoading={busy}
        okButtonProps={{ disabled: batchTagMode !== 'clear' && !batchTags.length }}
      >
        <Form layout="vertical">
          <Form.Item label="设置方式">
            <TagPicker
              value={batchTagMode}
              onChange={v => v && setBatchTagMode(v)}
              options={[
                { value: 'replace', label: '覆盖原标签' },
                { value: 'add', label: '追加标签' },
                { value: 'clear', label: '清空标签' },
              ]}
            />
          </Form.Item>
          {batchTagMode !== 'clear' && (
            <Form.Item label="自定义标签">
              <MultiTagPicker
                allowCustom
                value={batchTags}
                onChange={setBatchTags}
                options={classTagOptions.map(o => ({ ...o, color: classTagColor(o.value, tagColors) }))}
                customPlaceholder="输入自定义标签后按回车添加"
              />
            </Form.Item>
          )}
        </Form>
      </Modal>
      <Modal
        title={`批量重置密码（已选 ${validUserIds.length} 个教师账号）`}
        open={batchPwdOpen}
        onCancel={() => !busy && setBatchPwdOpen(false)}
        onOk={() => void saveBatchPassword()}
        confirmLoading={busy}
        okText="确认重置"
        okButtonProps={{ disabled: batchPwd.length < 10 || batchPwd.length > 200 }}
      >
        <Form layout="vertical">
          <Form.Item
            label="指定新密码（10 至 200 个字符）"
            extra="所有已选账号的密码将被统一设为该密码，且其当前登录状态会立即失效。"
          >
            <Input.Password
              autoComplete="new-password"
              placeholder="请输入统一密码，至少 10 个字符"
              value={batchPwd}
              onChange={e => setBatchPwd(e.target.value)}
            />
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        title={`批量设置角色（已选 ${validUserIds.length} 个教师账号）`}
        open={batchRoleOpen}
        onCancel={() => !busy && setBatchRoleOpen(false)}
        onOk={() => void saveBatchRole()}
        confirmLoading={busy}
        okText="确认修改"
      >
        <Form layout="vertical">
          <Form.Item label="目标角色">
            <TagPicker
              value={batchRole}
              onChange={v => v && setBatchRole(v)}
              options={[
                { value: 'teacher', label: '阅卷教师', color: 'default' },
                { value: 'manager', label: '管理教师', color: 'purple' },
              ]}
            />
          </Form.Item>
        </Form>
      </Modal>
    </>
  )
}

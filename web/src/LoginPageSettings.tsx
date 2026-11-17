import { useEffect, useState } from 'react'
import { App, Card, Form, Input, Space, Typography } from 'antd'
import { Button } from './Button'
import { ErrorNotice } from './EntityTable'
import { LoginFooterContent } from './LoginFooter'
import { send, useResource } from './api'

type FooterSettings = { html: string; rendered_html: string }

export function LoginPageSettings() {
  const resource = useResource<FooterSettings | null>('/system/login-footer', null, { live: false })
  const [html, setHtml] = useState(''), [preview, setPreview] = useState<string | null>(null)
  const [busy, setBusy] = useState(''), { message } = App.useApp()
  useEffect(() => {
    if (resource.data) {
      setHtml(resource.data.html)
      setPreview(resource.data.rendered_html)
    }
  }, [resource.data])
  async function showPreview() {
    setBusy('preview')
    try {
      const result = await send<{ html: string }>('/system/login-footer/preview', { html })
      setPreview(result.html)
    } catch (e) { message.error((e as Error).message) }
    finally { setBusy('') }
  }
  async function save() {
    setBusy('save')
    try {
      const result = await send<FooterSettings>('/system/login-footer', { html }, 'PUT')
      resource.setData(result)
      message.success('登录页底部信息已保存')
    } catch (e) { message.error((e as Error).message) }
    finally { setBusy('') }
  }
  const disabled = resource.loading || !!resource.error || !resource.data || !!busy
  return <Card title="登录页底部信息">
    <ErrorNotice error={resource.error} retry={resource.reload} />
    <Form layout="vertical" onFinish={save} style={{ maxWidth: 960 }}>
      <Form.Item label="底部 HTML" htmlFor="login-footer-html" extra="可填写备案号等信息，支持文字、链接、图片与常用行内样式。留空可隐藏。">
        <Input.TextArea id="login-footer-html" className="code-input" rows={8} maxLength={20000} showCount spellCheck={false}
          disabled={disabled} value={html} onChange={e => { setHtml(e.target.value); setPreview(null) }}
          placeholder={'<a href="https://beian.miit.gov.cn/">备案号</a>'} />
      </Form.Item>
      <Space style={{ marginBottom: 20 }}>
        <Button disabled={disabled} loading={busy === 'preview'} onClick={showPreview}>预览</Button>
        <Button type="primary" htmlType="submit" disabled={disabled} loading={busy === 'save'}>保存</Button>
      </Space>
      {preview !== null && <div className="login-footer-preview">
        {preview ? <LoginFooterContent html={preview} /> : <Typography.Text type="secondary">登录页底部信息已留空</Typography.Text>}
      </div>}
    </Form>
  </Card>
}

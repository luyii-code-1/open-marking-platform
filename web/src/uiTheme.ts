import type { ThemeConfig } from 'antd'

export const uiTheme: ThemeConfig = {
  token: {
    colorPrimary: '#0866ff', colorInfo: '#0866ff', colorSuccess: '#218755',
    colorText: '#1f2329', colorTextSecondary: '#6b7280', colorBorder: '#dce1e7',
    colorBgLayout: '#f5f7fa', borderRadius: 4,
    fontFamily: '"Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif',
    fontSize: 13, fontSizeHeading2: 24, fontSizeHeading3: 20, fontSizeHeading4: 16,
    controlHeight: 32, controlHeightSM: 24, controlHeightLG: 40,
  },
  components: {
    Card: { headerHeight: 44, headerHeightSM: 36, headerFontSize: 14, bodyPadding: 16, bodyPaddingSM: 12 },
    Table: { cellPaddingBlock: 6, cellPaddingInline: 12, cellPaddingBlockMD: 6, cellPaddingInlineMD: 12, headerBg: '#f1f4f8', headerColor: '#374151', rowHoverBg: '#f5f9ff' },
    Form: { itemMarginBottom: 16, verticalLabelPadding: '0 0 6px' },
    Menu: { itemHeight: 36, itemBorderRadius: 3, itemMarginBlock: 2, itemSelectedBg: '#edf4ff', groupTitleFontSize: 12 },
    Tabs: { horizontalMargin: '0 0 16px 0', horizontalItemPadding: '10px 0' },
    Modal: { titleFontSize: 16 },
    Statistic: { titleFontSize: 12, contentFontSize: 24 },
  },
}

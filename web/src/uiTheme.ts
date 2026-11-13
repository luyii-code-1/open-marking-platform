import type { ThemeConfig } from 'antd'

export const uiTheme: ThemeConfig = {
  token: {
    colorPrimary: '#0866ff', colorInfo: '#0866ff', colorSuccess: '#218755',
    colorText: '#141414', colorTextHeading: '#141414', colorTextSecondary: '#434343',
    colorTextTertiary: '#595959', colorTextPlaceholder: '#767676', colorBorder: '#d9d9d9',
    colorBgLayout: '#f5f7fa', borderRadius: 4,
    fontFamily: '"Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif',
    fontSize: 14, lineHeight: 22 / 14, fontSizeHeading2: 24, fontSizeHeading3: 20, fontSizeHeading4: 16,
    controlHeight: 36, controlHeightSM: 28, controlHeightLG: 40,
  },
  components: {
    Card: { headerHeight: 48, headerHeightSM: 40, headerFontSize: 16, bodyPadding: 16, bodyPaddingSM: 12 },
    Table: { cellFontSize: 14, cellFontSizeMD: 14, cellFontSizeSM: 14, cellPaddingBlock: 16, cellPaddingInline: 16, cellPaddingBlockMD: 12, cellPaddingInlineMD: 12, cellPaddingBlockSM: 8, headerBg: '#f5f5f5', headerColor: '#141414', borderColor: '#e8e8e8', rowHoverBg: '#f5f9ff' },
    Select: { optionHeight: 36, optionFontSize: 14, optionPadding: '7px 12px' },
    Dropdown: { paddingBlock: 8 },
    List: { itemPadding: '16px 0', itemPaddingSM: '10px 0' },
    Form: { itemMarginBottom: 16, verticalLabelPadding: '0 0 6px' },
    Menu: { itemHeight: 40, itemBorderRadius: 3, itemMarginBlock: 2, itemSelectedBg: '#edf4ff', groupTitleFontSize: 13 },
    Tabs: { horizontalMargin: '0 0 16px 0', horizontalItemPadding: '10px 0' },
    Modal: { titleFontSize: 16 },
    Statistic: { titleFontSize: 14, contentFontSize: 24 },
  },
}

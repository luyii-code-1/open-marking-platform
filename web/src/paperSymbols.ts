// Text inserted into the answer sheet by the symbol palette.
export const paperSymbolGroups=[
  {key:'numbers',label:'序号',symbols:[...Array.from({length:20},(_,index)=>String.fromCodePoint(0x2460+index)),...Array.from({length:10},(_,index)=>`（${index+1}）`)]},
  {key:'math',label:'数学',symbols:[...'±×÷≠≈≤≥∞√π°∠△∵∴αβγδθλμΣ→←↔℃‰']},
  {key:'marks',label:'常用',symbols:[...'○●□■◇◆△▲☆★✓✗※§①②③④⑤']},
]

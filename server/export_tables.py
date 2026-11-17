import csv
import io
import re
from collections.abc import Iterable, Sequence
from typing import Literal, NamedTuple

from fastapi import HTTPException
from fastapi.responses import Response
from openpyxl import Workbook
from openpyxl.cell import WriteOnlyCell
from openpyxl.cell.cell import ILLEGAL_CHARACTERS_RE
from openpyxl.styles import Font, PatternFill,Alignment,Border,Side
from openpyxl.utils import get_column_letter

FileFormat = Literal['xlsx', 'csv']
XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
HEADER_FONT = Font(bold=True, color='FFFFFF')
HEADER_FILL = PatternFill('solid', fgColor='335478')


class ExportTable(NamedTuple):
    title: str
    headers: list[str]
    rows: Iterable[Sequence]
    freeze: str = 'A2'


class RankingTable(NamedTuple):
    title:str
    subtitle:str
    headers:list[str]
    rows:Iterable[Sequence]
    groups:list[tuple[str,int,int]]
    highlight_columns:tuple[int,...]=()
    rank_columns:tuple[int,...]=()


def ranking_response(tables,filename,file_format='xlsx'):
    tables=list(tables)
    if file_format=='csv':
        headers=tables[0].headers if tables else []
        return table_response(ExportTable('成绩排名',headers,(row for table in tables for row in table.rows)),filename,'csv')
    book=Workbook();book.remove(book.active);taken=set()
    fill=PatternFill('solid',fgColor='23465F');highlight=PatternFill('solid',fgColor='FFF2CC')
    edge=Side(style='thin',color='CBD5DF')
    for table in tables:
        sheet=book.create_sheet(worksheet_name(table.title,taken));last_column=len(table.headers)
        sheet.merge_cells(start_row=1,start_column=1,end_row=1,end_column=last_column)
        sheet.merge_cells(start_row=2,start_column=1,end_row=2,end_column=last_column)
        sheet.cell(1,1,table.title).font=Font(name='微软雅黑',size=16,bold=True,color='23465F')
        sheet.cell(2,1,table.subtitle).font=Font(name='微软雅黑',size=10,color='465B6A')
        sheet.cell(1,1).data_type='s';sheet.cell(2,1).data_type='s'
        for label,start,end in table.groups:
            if end>start:sheet.merge_cells(start_row=3,start_column=start,end_row=3,end_column=end)
            sheet.cell(3,start,label).data_type='s'
        for index,label in enumerate(table.headers,1):
            sheet.cell(4,index,label).data_type='s'
            sheet.column_dimensions[get_column_letter(index)].width=18 if len(label)<9 else 23
        for row in sheet.iter_rows(min_row=3,max_row=4,max_col=last_column):
            for cell in row:
                cell.font=Font(name='微软雅黑',size=10,bold=True,color='FFFFFF');cell.fill=fill
                cell.alignment=Alignment(horizontal='center',vertical='center',wrap_text=True);cell.border=Border(left=edge,right=edge,top=edge,bottom=edge)
        for row_index,row in enumerate(table.rows,5):
            for column,value in enumerate(row,1):
                cell=sheet.cell(row_index,column,ILLEGAL_CHARACTERS_RE.sub('',value) if isinstance(value,str) else value)
                if isinstance(value,str):cell.data_type='s'
                cell.font=Font(name='微软雅黑',size=11 if column in table.rank_columns else 10,bold=column in table.rank_columns)
                cell.alignment=Alignment(horizontal='center',vertical='center',wrap_text=True)
                cell.border=Border(left=edge,right=edge,top=edge,bottom=edge)
                if column in table.highlight_columns:cell.fill=highlight
                if isinstance(value,(int,float)):cell.number_format='0.##'
        sheet.freeze_panes='A5';sheet.auto_filter.ref=f'A4:{get_column_letter(last_column)}{max(4,sheet.max_row)}'
        sheet.row_dimensions[1].height=30;sheet.row_dimensions[2].height=30
        sheet.row_dimensions[3].height=24;sheet.row_dimensions[4].height=32
        sheet.print_title_rows='1:4';sheet.sheet_properties.pageSetUpPr.fitToPage=True
        sheet.page_setup.orientation='landscape';sheet.page_setup.paperSize=sheet.PAPERSIZE_A4
        sheet.page_setup.fitToWidth=1;sheet.page_setup.fitToHeight=0
    output=io.BytesIO();book.save(output)
    return Response(output.getvalue(),media_type=XLSX_TYPE,headers={'Content-Disposition':f'attachment; filename="{filename}.xlsx"','Cache-Control':'private, no-store'})


def worksheet_name(title, taken):
    clean = re.sub(r"[\\/*?:\[\]]", '-', ILLEGAL_CHARACTERS_RE.sub('', title)).strip(" '") or '题卡'
    name = clean[:31].rstrip(" '")
    sequence = 2
    while name.casefold() in taken:
        suffix = f' ({sequence})'
        name = clean[:31 - len(suffix)].rstrip(" '") + suffix
        sequence += 1
    taken.add(name.casefold())
    return name


def excel_cell(sheet, value):
    if isinstance(value, str):
        cell = WriteOnlyCell(sheet, value=ILLEGAL_CHARACTERS_RE.sub('', value))
        cell.data_type = 's'
        return cell
    return WriteOnlyCell(sheet, value=value)


def workbook_response(tables, filename):
    book = Workbook(write_only=True)
    used_names = set()
    for table in tables:
        sheet = book.create_sheet(worksheet_name(table.title, used_names))
        sheet.freeze_panes = table.freeze
        for index, label in enumerate(table.headers, 1):
            sheet.column_dimensions[get_column_letter(index)].width = max(16, min(38, 2 * len(label) + 4))
        headings = [excel_cell(sheet, label) for label in table.headers]
        for cell in headings:
            cell.font = HEADER_FONT
            cell.fill = HEADER_FILL
        sheet.append(headings)
        last_row = 1
        for last_row, row in enumerate(table.rows, 2):
            sheet.append([excel_cell(sheet, value) for value in row])
        sheet.auto_filter.ref = f'A1:{get_column_letter(len(headings))}{last_row}'
    if not used_names:
        raise HTTPException(409, '当前考试没有可导出小题分的题卡')
    output = io.BytesIO()
    book.save(output)
    return Response(output.getvalue(), media_type=XLSX_TYPE, headers={
        'Content-Disposition': f'attachment; filename="{filename}.xlsx"', 'Cache-Control': 'private, no-store',
    })


def table_response(table: ExportTable, filename: str, file_format: FileFormat):
    if file_format == 'xlsx':
        return workbook_response([table], filename)
    from .operations import csv_cell
    output = io.StringIO(newline='')
    writer = csv.writer(output)
    writer.writerow([csv_cell(value) for value in table.headers])
    writer.writerows([csv_cell(value) for value in row] for row in table.rows)
    return Response(('\ufeff' + output.getvalue()).encode('utf-8'), media_type='text/csv; charset=utf-8', headers={
        'Content-Disposition': f'attachment; filename={filename}.csv', 'Cache-Control': 'private, no-store',
    })

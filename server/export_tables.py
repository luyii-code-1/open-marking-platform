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
from openpyxl.styles import Font, PatternFill
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

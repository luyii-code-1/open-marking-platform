namespace OMP.Scanner;

public sealed record DuplexSlot(string Side, int Sequence, string FirstSide, bool InvalidState = false);

public static class DuplexOrder
{
    private static void Configuration(BatchRow batch)
    {
        if (batch.CaptureMode != "duplex" || batch.Sides != 2 || batch.BackOrder != "same")
            throw new InvalidOperationException("自动双面仅适用于同序配对的双面题卡批次。");
    }

    public static void RequireComplete(BatchRow batch, IReadOnlyList<PageRow> pages)
    {
        Configuration(batch);
        var active = pages.Where(p => p.Status != "excluded").ToList();
        if (active.Count > 0 && batch.DuplexFirstSide is not ("front" or "back"))
            throw new InvalidOperationException("自动双面出图顺序缺失，请新建批次。");
        if (active.GroupBy(p => p.Sequence).Any(g => g.Count() != 2 || g.Select(p => p.Side).Distinct().Count() != 2))
            throw new InvalidOperationException("自动双面有未配齐的纸张。请核对并排除该纸张已采集的两面（或缺失的一面），再整张重扫；不能直接接着放入下一张纸。");
    }

    public static DuplexSlot Next(BatchRow batch, IReadOnlyList<PageRow> pages, string? detectedSide)
    {
        Configuration(batch);
        var first = batch.DuplexFirstSide;
        if (first.Length == 0 && detectedSide is "front" or "back") first = detectedSide;
        var groups = pages.Where(p => p.Status != "excluded").GroupBy(p => p.Sequence).OrderBy(g => g.Key).ToList();
        var partial = groups.Where(g => g.Count() != 2 || g.Select(p => p.Side).Distinct().Count() != 2).ToList();
        var next = pages.Select(p => p.Sequence).DefaultIfEmpty(0).Max() + 1;
        if (partial.Count == 0) return new DuplexSlot(first.Length == 0 ? "front" : first, next, first);
        if (partial.Count == 1 && partial[0] == groups.Last() && partial[0].Count() == 1)
            return new DuplexSlot(partial[0].Single().Side == "front" ? "back" : "front", partial[0].Key, first);
        return new DuplexSlot(first.Length == 0 ? "front" : first, next, first, true);
    }
}

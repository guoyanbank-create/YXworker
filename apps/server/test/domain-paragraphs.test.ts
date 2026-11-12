import { describe, expect, it } from 'vitest';
import {
  applyParagraphText,
  buildContentJson,
  diffBlocks,
  extractParagraphs,
  findParagraphNode,
  hashText,
  nodeText,
  validateSingleParagraphChange,
} from '../src/domain/paragraphs.js';

function demoDoc() {
  return buildContentJson([
    { title: '第一章 项目背景', paragraphs: ['背景一', '背景二'] },
    { title: '第二章 方案概述', paragraphs: ['概述一'] },
    { title: '第三章 功能拆解', paragraphs: ['功能一', '功能二', '功能三'] },
  ]);
}

describe('段落块派生', () => {
  it('按文档顺序派生块并标注章节', () => {
    const blocks = extractParagraphs(demoDoc());
    expect(blocks.map((b) => b.type)).toEqual([
      'heading',
      'paragraph',
      'paragraph',
      'heading',
      'paragraph',
      'heading',
      'paragraph',
      'paragraph',
      'paragraph',
    ]);
    expect(blocks[0].chapterIndex).toBe(0);
    expect(blocks[0].chapterTitle).toBe('第一章 项目背景');
    expect(blocks[1].chapterIndex).toBe(0);
    expect(blocks[5].chapterIndex).toBe(2);
    expect(blocks[5].chapterTitle).toBe('第三章 功能拆解');
    expect(blocks[6].text).toBe('功能一');
    expect(blocks[6].hash).toBe(hashText('功能一'));
  });

  it('文本抽取忽略格式标记、拼接多段 text 节点', () => {
    const content = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { paragraphId: 'p1' },
          content: [
            { type: 'text', text: '加粗', marks: [{ type: 'bold' }] },
            { type: 'text', text: '常规' },
          ],
        },
      ],
    };
    const blocks = extractParagraphs(content);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe('加粗常规');
  });

  it('列表项段落参与抽取并标注列表类型', () => {
    const content = {
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                { type: 'paragraph', attrs: { paragraphId: 'li1' }, content: [{ type: 'text', text: '条目一' }] },
              ],
            },
          ],
        },
      ],
    };
    const blocks = extractParagraphs(content);
    expect(blocks[0]).toMatchObject({ id: 'li1', type: 'listItem', listKind: 'bulletList', text: '条目一' });
  });

  it('缺失 paragraphId 时使用稳定兜底 id', () => {
    const content = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'a' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'b' }] },
      ],
    };
    expect(extractParagraphs(content).map((b) => b.id)).toEqual(['auto_0', 'auto_1']);
  });
});

describe('段落应用与校验', () => {
  it('替换目标段落文本并保留块类型', () => {
    const content = demoDoc();
    const blocks = extractParagraphs(content);
    const target = blocks[6];
    const result = applyParagraphText(content, target.id, '功能一（修订）');
    expect(result.applied).toBe(true);
    const after = extractParagraphs(result.contentJson);
    expect(after[6].text).toBe('功能一（修订）');
    expect(after[6].type).toBe(target.type);
    expect(validateSingleParagraphChange(blocks, after, target.id, '功能一（修订）').ok).toBe(true);
  });

  it('校验拒绝非目标段落变化', () => {
    const content = demoDoc();
    const before = extractParagraphs(content);
    const patched = applyParagraphText(content, before[6].id, '功能一（修订）').contentJson as ReturnType<typeof demoDoc>;
    // 模拟前端同时改了别的段落
    (patched.content[7] as { content: { type: string; text: string }[] }).content = [
      { type: 'text', text: '被偷偷改动的功能二' },
    ];
    const after = extractParagraphs(patched);
    const result = validateSingleParagraphChange(before, after, before[6].id, '功能一（修订）');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('非目标段落');
  });

  it('校验拒绝目标段落文本不符', () => {
    const content = demoDoc();
    const before = extractParagraphs(content);
    const patched = applyParagraphText(content, before[6].id, '实际写入内容').contentJson;
    const after = extractParagraphs(patched);
    expect(validateSingleParagraphChange(before, after, before[6].id, '期望内容').ok).toBe(false);
  });

  it('节点查找与文本抽取', () => {
    const doc = demoDoc();
    expect(findParagraphNode(doc, 'p_003')).not.toBeNull();
    expect(nodeText(findParagraphNode(doc, 'p_003'))).toBe('背景二');
    expect(findParagraphNode(doc, '不存在')).toBeNull();
  });
});

describe('块差异', () => {
  it('返回修改/新增/删除', () => {
    const before = extractParagraphs(demoDoc());
    const afterContent = applyParagraphText(demoDoc(), before[6].id, '功能一（修订）').contentJson;
    const changes = diffBlocks(before, extractParagraphs(afterContent));
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: 'modified', after: '功能一（修订）' });
  });
});

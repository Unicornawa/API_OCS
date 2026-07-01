function lowerText(value) {
  return String(value || '').toLowerCase();
}

function stripQuestionPrefix(title) {
  return String(title || '')
    .replace(/^[A-Za-z0-9_-]{3,}[*:：\.\s-]+/, '')
    .replace(/^[A-Za-z]{1,6}\d+[A-Za-z0-9_-]*[*:：\.\s-]+/, '')
    .trim();
}

function countMatches(text, patterns) {
  return patterns.reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0);
}

function detectDomain(question) {
  const title = lowerText(question.cleanedTitle || question.title);
  const options = lowerText((question.options || []).map((item) => item.text).join(' '));
  const text = `${title} ${options}`;

  const physicsScore = countMatches(text, [
    /物理|力学|热学|电磁|光学|量子|相对论/,
    /速度|加速度|位移|动量|冲量|角速度|角加速度/,
    /力|牛顿|摩擦|重力|弹力|压强|浮力|张力/,
    /功|能量|动能|势能|功率|机械能/,
    /电场|磁场|电势|电压|电流|电阻|电容|电荷|安培|欧姆/,
    /波长|频率|振幅|折射|反射|干涉|衍射/,
    /温度|热量|内能|熵|气体|液体|固体|润湿|接触角/,
    /\bkg\b|\bn\b|\bj\b|\bw\b|\bv\b|\ba\b|\bohm\b|\bpa\b|\bm\/s\b/,
  ]);

  const mathScore = countMatches(text, [
    /数学|函数|方程|不等式|数列|集合|命题/,
    /导数|微分|积分|极限|连续|收敛|发散/,
    /矩阵|行列式|向量|特征值|线性|空间/,
    /概率|随机|期望|方差|统计|分布|样本/,
    /几何|三角|正弦|余弦|圆|椭圆|抛物线/,
    /求解|计算|证明|化简|展开|因式分解/,
    /[∫∑√∞≤≥≠≈πθαβγ]/,
  ]);

  const definitionScore = countMatches(text, [
    /定义|概念|含义|是指|称为|又称|所谓/,
    /特征|特点|性质|原则|作用|功能|组成|内容|分类/,
    /下列.*正确|下列.*错误|关于.*说法|属于|不属于/,
  ]);

  if (physicsScore >= Math.max(2, mathScore + 1, definitionScore)) {
    return 'physics';
  }
  if (mathScore >= Math.max(2, physicsScore + 1, definitionScore)) {
    return 'math';
  }
  if (definitionScore >= 1) {
    return 'definition';
  }
  return 'general';
}

function inferQuestionKind(question) {
  const title = lowerText(question.cleanedTitle || question.title);
  const type = lowerText(question.type);
  const text = `${type} ${title}`;
  const options = question.options || [];

  if (/多选|多项|复选|不定项|multiple|multi-select|checkbox|哪些|哪几/.test(text)) {
    return 'multiple';
  }
  if (/判断|正误|对错|true|false|tf|judge/.test(text)) {
    return 'judge';
  }
  if (/填空|blank|completion/.test(text)) {
    return 'blank';
  }
  if (/简答|问答|short|essay/.test(text)) {
    return 'short';
  }
  if (/单选|单项|single|radio/.test(text)) {
    return 'single';
  }

  if (options.length === 2) {
    const optionText = options.map((item) => lowerText(item.text)).join(' ');
    if (/正确|错误|对|错|true|false/.test(optionText)) {
      return 'judge';
    }
  }
  if (options.length > 0) {
    return 'single';
  }
  return 'short';
}

module.exports = {
  detectDomain,
  inferQuestionKind,
  stripQuestionPrefix,
};

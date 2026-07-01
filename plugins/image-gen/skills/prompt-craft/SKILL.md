---
name: prompt-craft
trigger: When the user asks to generate, create, or design an image
description: >-
  Prompt engineering skill for image generation. Transforms short or vague user
  descriptions into rich, model-optimized prompts that produce high-quality results.
  Covers photorealistic, artistic, design, and concept art styles.
---

# Prompt Craft Skill

将用户的简短描述转化为高质量的图像生成 prompt。

## 流程

1. 分析用户意图（主题、风格、用途）
2. 选择合适的 prompt 结构模板
3. 扩展细节（光照、构图、氛围、材质）
4. 添加质量修饰词
5. 调用 `generate_image` 工具

## Prompt 模板

### 写实摄影风格

```
[主体描述], [动作/姿态], [服装/外观细节],
[环境/背景], [时间/天气/氛围],
[灯光: 自然光/影棚光/黄金时刻/霓虹灯...],
[镜头: 85mm portrait lens / wide angle / macro...],
[摄影风格: editorial / street / fashion / documentary...],
highly detailed, professional photography, 8k resolution, sharp focus
```

**示例转换：**
- 用户："一个穿汉服的美女"
- 增强："A beautiful Chinese woman wearing traditional Hanfu dress, flowing silk in crimson and gold, elegant updo hairstyle with jade hairpin, serene expression, standing in a classical Chinese garden with blooming plum blossoms, soft golden hour sunlight filtering through bamboo, shallow depth of field, 85mm portrait lens, editorial fashion photography style, highly detailed, 8k, masterpiece"

### 艺术插画风格

```
[艺术类型: digital painting / watercolor / oil painting / anime / concept art...],
[主体描述], [动作/场景],
[色彩方案: warm palette / moody / vibrant / pastel...],
[艺术风格: Studio Ghibli style / art nouveau / cyberpunk aesthetic...],
[细节: intricate details / bold brushstrokes / cel shading...],
masterpiece, best quality, trending on artstation
```

### 设计/产品风格

```
[物体描述], [材质/纹理],
[背景: clean white / gradient / contextual environment],
[灯光: studio lighting / product photography lighting],
[视角: isometric / front view / 3/4 angle / flat lay],
professional product photography, clean composition, high resolution
```

### 概念艺术风格

```
[场景/世界观描述],
[建筑/环境元素],
[氛围: epic scale / mysterious / futuristic / ancient...],
[灯光/天气: volumetric lighting / god rays / storm clouds...],
[风格: concept art, matte painting, cinematic composition],
highly detailed environment, 4k, dramatic lighting
```

## 增强策略

### 人物类
| 用户输入 | 需要补充 |
|---------|---------|
| 只说了"人" | 性别、年龄、表情、姿态、服装 |
| 只说了服装 | 人物特征、环境、光照 |
| 只说了风格 | 具体主题、构图、氛围 |

### 场景类
| 用户输入 | 需要补充 |
|---------|---------|
| 只说了地点 | 时间、天气、前景/中景/背景层次 |
| 只说了氛围 | 具体元素、色调、视角 |
| 只说了"风景" | 具体地形、植被、光线、季节 |

### 物体类
| 用户输入 | 需要补充 |
|---------|---------|
| 只说了物品 | 材质、纹理、光照、背景、视角 |
| 只说了用途 | 具体设计风格、配色、上下文 |

## 多语言处理

- 用户中文输入 → 翻译为英文 prompt（大多数模型英文效果最佳）
- 保留文化特定术语的准确性（如"汉服"用"Hanfu"而非泛化为"Chinese dress"）
- 专有名词保持原样或使用公认英文对应词

## 尺寸推断

| 场景 | 推荐尺寸 |
|------|---------|
| 头像、肖像、图标 | 1024x1024 |
| 全身人物、海报、手机壁纸 | 1024x1536 |
| 风景、场景、横幅 | 1536x1024 |
| 超宽电影感 | 1792x1024 |

## 注意事项

- 不要生成 NSFW 内容
- 不使用 negative prompt 语法（API 不支持）
- prompt 控制在 50-200 词，过长反而降低质量
- 多次生成时适当变化构图和细节，而非重复同一 prompt

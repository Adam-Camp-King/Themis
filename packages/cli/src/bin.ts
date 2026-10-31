#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam Campbell
import { main } from './cli.js';

process.exitCode = main(process.argv.slice(2));

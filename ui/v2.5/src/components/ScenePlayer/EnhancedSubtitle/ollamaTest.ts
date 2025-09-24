// Test script for Ollama integration
// This can be run in browser console to test the Ollama service

import { ollamaService } from './ollamaService';
import { dictionaryService, lookupWordWithContext } from './dictionary';

// Test function to check Ollama integration
export async function testOllamaIntegration() {
  console.log('🧪 Testing Ollama Integration...');
  
  try {
    // Test 1: Check if Ollama service is available
    console.log('🔍 Test 1: Checking Ollama availability...');
    const isAvailable = await ollamaService.isAvailable();
    console.log('✅ Ollama available:', isAvailable);
    
    if (!isAvailable) {
      console.warn('❌ Ollama service is not available at 192.168.1.113:11434');
      console.log('💡 Make sure:');
      console.log('  1. Ollama is running on 192.168.1.113');
      console.log('  2. Ollama is listening on 0.0.0.0:11434 (not just localhost)');
      console.log('  3. Firewall allows port 11434');
      return false;
    }
    
    // Test 2: Get available models
    console.log('🔍 Test 2: Getting available models...');
    const models = await ollamaService.getModels();
    console.log('✅ Available models:', models);
    
    if (models.length === 0) {
      console.warn('❌ No models found on Ollama service');
      return false;
    }
    
    // Test 3: Test word explanation with context
    console.log('🔍 Test 3: Testing word explanation with context...');
    const testWord = 'run';
    const testContext = 'I like to run in the park every morning.';
    
    try {
      const explanation = await ollamaService.explainWord(testWord, testContext, 'en');
      console.log('✅ Word explanation result:', explanation);
    } catch (error) {
      console.error('❌ Word explanation failed:', error);
      return false;
    }
    
    // Test 4: Test dictionary service integration
    console.log('🔍 Test 4: Testing dictionary service integration...');
    const dictResult = await lookupWordWithContext(testWord, testContext, 'en');
    console.log('✅ Dictionary service result:', dictResult);
    
    // Test 5: Check dictionary service Ollama status
    console.log('🔍 Test 5: Checking dictionary service Ollama status...');
    const ollamaStatus = dictionaryService.isOllamaAvailable();
    console.log('✅ Dictionary service Ollama status:', ollamaStatus);
    
    console.log('🎉 All tests passed! Ollama integration is working.');
    return true;
    
  } catch (error) {
    console.error('❌ Test failed with error:', error);
    return false;
  }
}

// Test with different contexts
export async function testMultipleContexts() {
  console.log('🧪 Testing multiple contexts...');
  
  const testCases = [
    {
      word: 'bank',
      context: 'I went to the bank to deposit money.',
      expected: 'financial institution'
    },
    {
      word: 'bank',
      context: 'We sat on the bank of the river.',
      expected: 'river side'
    },
    {
      word: 'light',
      context: 'The light is too bright.',
      expected: 'illumination'
    },
    {
      word: 'light',
      context: 'This box is very light.',
      expected: 'not heavy'
    }
  ];
  
  for (const testCase of testCases) {
    console.log(`🔍 Testing: "${testCase.word}" in "${testCase.context}"`);
    try {
      const result = await lookupWordWithContext(testCase.word, testCase.context, 'en');
      console.log('✅ Result:', result?.definitions[0]?.meaning);
    } catch (error) {
      console.error('❌ Failed:', error);
    }
  }
}

// Quick test function for browser console
export async function quickTest() {
  console.log('🚀 Quick Ollama test...');
  const result = await testOllamaIntegration();
  if (result) {
    console.log('🎉 Integration working! Try clicking on words in subtitles.');
  } else {
    console.log('❌ Integration not working. Check Ollama service.');
  }
  return result;
}

// Export for global usage in browser console
(window as any).testOllama = {
  testOllamaIntegration,
  testMultipleContexts,
  quickTest,
  ollamaService,
  dictionaryService
};
